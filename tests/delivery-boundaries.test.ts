import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FrontendReply, OutgoingAttachment, QueuedMessage, TaskInput } from '@qqbot/contracts';
import { createTaskBudget, createTaskLifeCycleManagerV3 } from '../src/task/index.js';
import { createMessageQueue, createSessionOutputCoordinatorV3 } from '../src/delivery/index.js';
import { createNullLogger } from '../src/observability/index.js';
import { renderReplyText, renderReference } from '../src/content/index.js';
import { createStateWriter, renderReplay, renderWindowBlock } from '../src/store/index.js';
import { renderMessage } from '../src/adapters/qq-official/render.js';
import { MemoryConnector } from './bench/session/connector.js';
import { OnebotProbe, digest } from './bench/session/onebot-probe.js';
import { recordBenchmarkEvidence } from './bench/frontend-worker/evidence.js';

async function deliveryHarness() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-boundaries-'));
  const connector = new MemoryConnector();
  connector.recordCapable = true;
  const probe = new OnebotProbe(connector, { fileTransport: 'path' });
  await probe.start();
  const manager = createTaskLifeCycleManagerV3();
  const messageStore = createStateWriter<QueuedMessage, 'messages'>(
    'messages',
    join(root, 'messages.json')
  );
  const queue = createMessageQueue({
    connectors: new Map([['onebot', connector]]),
    logger: createNullLogger(),
    store: messageStore,
  });
  const output = createSessionOutputCoordinatorV3({
    manager,
    queue,
    budget: createTaskBudget(),
    filesDir: join(root, 'saved'),
    maxChars: () => connector.maxChars,
    policy: () => connector.policy('group'),
  });
  const message: TaskInput['message'] = {
    kind: 'group-message',
    target: { key: 'onebot:group:123', id: '123', platform: 'onebot', kind: 'group' },
    senderId: '10001',
    msgId: 'origin',
    eventId: 'origin',
    content: '原始问题',
    ts: Date.now(),
    raw: {},
  };
  const created = manager.create(
    {
      source: 'user',
      generation: 1,
      isAdmin: false,
      message,
      reference: { messageId: 'origin', senderId: '10001', excerpt: '原始问题', ts: message.ts },
      context: { replay: '', window: [] },
    },
    'delivery-task'
  );
  if (!created.ok) throw new Error(created.error.code);
  const task = manager.get('delivery-task')!;
  return {
    root,
    connector,
    probe,
    queue,
    output,
    task,
    messageStore,
    async file(name: string, content: string): Promise<OutgoingAttachment> {
      const absPath = join(root, name);
      await writeFile(absPath, content);
      return {
        kind: name.endsWith('.png') ? 'image' : 'file',
        fileName: name,
        absPath,
        sizeBytes: Buffer.byteLength(content),
      };
    },
    async send(reply: FrontendReply) {
      await output.accept(task, reply);
      await this.idle();
    },
    idle(): Promise<void> {
      const settled = () => queue.snapshot().pending === 0 && queue.snapshot().sending === 0;
      if (settled()) return Promise.resolve();
      return new Promise((resolve) => {
        const off = queue.onDelivery(() => {
          if (settled()) {
            off();
            resolve();
          }
        });
      });
    },
    async close() {
      output.close();
      queue.close();
      await probe.stop();
      await recordBenchmarkEvidence(
        `delivery-boundaries:${queue.messages()[0]?.candidate.delivery?.groupId ?? 'reference-render'}`,
        {
          actions: probe.actions,
          queue: queue.snapshot(),
          delivery: queue.messages().map((row) => ({
            id: row.id,
            status: row.status,
            body: row.candidate.body,
            inlineAttachments: row.candidate.inlineAttachments,
            attachment: row.candidate.attachment,
            delivery: row.candidate.delivery,
          })),
          listenersAfterClose: probe
            .eventNames()
            .reduce((count, name) => count + probe.listenerCount(name), 0),
        }
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('测试环境交付边界', () => {
  it('单图和短正文使用一次普通OneBot动作并保留原引用和原作者提醒', async () => {
    const h = await deliveryHarness();
    try {
      const image = await h.file('single.png', 'single-image-bytes');
      await h.send({
        replyId: 'single',
        text: '**图已生成**',
        attention: 'strong',
        attachments: [image],
      });
      expect(h.probe.actions.map((action) => action.action)).toEqual(['send_group_msg']);
      expect(h.probe.actions[0]?.nodes.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: '图已生成' }),
          expect.objectContaining({ type: 'reply', id: 'origin' }),
          expect.objectContaining({ type: 'at', mention: '10001' }),
          expect.objectContaining({ type: 'image', sha256: digest('single-image-bytes') }),
        ])
      );
      expect(
        h.queue.messages().filter((row) => row.candidate.inlineAttachments?.length)
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('图片不进入混合资料ZIP且CSV与PDF字节完整保存', async () => {
    const h = await deliveryHarness();
    try {
      const attachments = [
        await h.file('chart.png', 'image-pixels'),
        await h.file('table.csv', 'name,value\nA,42\n'),
        await h.file('report.pdf', '%PDF-report'),
      ];
      await h.send({ replyId: 'mixed', text: '图和资料已整理', attachments });
      expect(h.probe.actions.map((action) => action.action)).toEqual([
        'send_group_msg',
        'upload_group_file',
      ]);
      expect(h.probe.actions[0]?.nodes.flat()).toContainEqual(
        expect.objectContaining({ type: 'image', sha256: digest('image-pixels') })
      );
      expect(h.probe.actions[1]?.zipEntries?.map((entry) => [entry.name, entry.sha256])).toEqual([
        ['table.csv', digest('name,value\nA,42\n')],
        ['report.pdf', digest('%PDF-report')],
      ]);
      expect(new Set(h.queue.messages().map((row) => row.candidate.delivery?.groupId)).size).toBe(
        1
      );
    } finally {
      await h.close();
    }
  });

  it('单份CSV也只上传一个ZIP', async () => {
    const h = await deliveryHarness();
    try {
      await h.send({
        replyId: 'csv',
        text: '表格已整理',
        attachments: [await h.file('only.csv', 'x,y\n1,2\n')],
      });
      expect(h.probe.actions.filter((action) => action.action.includes('upload'))).toHaveLength(1);
      expect(h.probe.actions.at(-1)?.zipEntries).toEqual([
        { name: 'only.csv', sha256: digest('x,y\n1,2\n'), sizeBytes: 8 },
      ]);
    } finally {
      await h.close();
    }
  });

  it('多图和正文使用一条平铺转发且所有图片字节保留', async () => {
    const h = await deliveryHarness();
    try {
      await h.send({
        replyId: 'images',
        text: '两张图已整理',
        attachments: [
          await h.file('first.png', 'first-image'),
          await h.file('second.png', 'second-image'),
        ],
      });
      expect(h.probe.actions.map((action) => action.action)).toEqual([
        'send_group_msg',
        'send_group_forward_msg',
      ]);
      const record = h.probe.actions.at(-1)!;
      expect(record.nodes).toHaveLength(3);
      expect(
        record.nodes
          .flat()
          .filter((node) => node.type === 'image')
          .map((node) => node.sha256)
      ).toEqual([digest('first-image'), digest('second-image')]);
      expect(record.nodes.flat().some((node) => node.type === 'node')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('入队副本在源图片和资料删除后仍发送相同字节', async () => {
    const h = await deliveryHarness();
    try {
      h.connector.connected = false;
      const image = await h.file('saved.png', 'saved-image'),
        file = await h.file('saved.pdf', 'saved-file');
      await h.output.accept(h.task, {
        replyId: 'saved',
        text: '保存结果',
        attachments: [image, file],
      });
      await unlink(image.absPath);
      await unlink(file.absPath);
      h.connector.connected = true;
      h.queue.wake();
      await h.idle();
      expect(h.probe.actions[0]?.nodes.flat()).toContainEqual(
        expect.objectContaining({ type: 'image', sha256: digest('saved-image') })
      );
      expect(h.probe.actions.at(-1)?.zipEntries).toEqual([
        { name: 'saved.pdf', sha256: digest('saved-file'), sizeBytes: 10 },
      ]);
    } finally {
      await h.close();
    }
  });

  it('持久队列恢复后单图正文仍只发送一次并使用保存的独立字节', async () => {
    const h = await deliveryHarness();
    let restored: ReturnType<typeof createMessageQueue> | undefined;
    try {
      h.connector.connected = false;
      const image = await h.file('restored.png', 'restored-image-bytes');
      const reply = { replyId: 'restored', text: '恢复后的图', attachments: [image] };
      await h.output.accept(h.task, reply);
      const savedPath = h.queue.messages()[0]?.candidate.inlineAttachments?.[0]?.absPath;
      expect(savedPath).toBeDefined();
      expect(savedPath).not.toBe(image.absPath);
      expect(h.queue.messages()[0]?.candidate.body?.textFormat).toBe('plain');
      h.queue.close();
      await unlink(image.absPath);
      h.connector.connected = true;
      restored = createMessageQueue({
        connectors: new Map([['onebot', h.connector]]),
        store: h.messageStore,
        logger: createNullLogger(),
      });
      const delivered = new Promise<void>((resolve) => {
        const off = restored!.onDelivery(() => {
          off();
          resolve();
        });
      });
      restored.wake();
      await delivered;
      expect(restored.messages()[0]?.status).toBe('sent');
      expect(restored.messages()[0]?.candidate.body?.textFormat).toBe('plain');
      expect(h.probe.actions.map((action) => action.action)).toEqual(['send_group_msg']);
      expect(h.probe.actions[0]?.nodes.flat()).toContainEqual(
        expect.objectContaining({ type: 'image', sha256: digest('restored-image-bytes') })
      );
      restored.enqueue(restored.messages()[0]!.candidate, restored.messages()[0]!.id);
      expect(h.probe.actions).toHaveLength(1);
    } finally {
      restored?.close();
      await recordBenchmarkEvidence('delivery-boundaries:restored-active-queue', {
        queue: restored?.snapshot(),
        messages: restored?.messages(),
        actions: h.probe.actions,
      });
      await h.close();
    }
  });

  it('完整正文转换后再切分且代码空白Markdown字面量和emoji连接符保留', async () => {
    const h = await deliveryHarness();
    try {
      h.connector.maxChars = 12;
      const code = "const value = '**literal**';  \n\n\n  👩‍💻 | x |\n";
      const text = '# 标题\n**正文**\n```ts\n' + code + '```\n行内 `  **literal**  ` 结束';
      const expected = '标题\n正文\n' + code + '\n行内   **literal**   结束';
      expect(renderReplyText(text, 'plain')).toBe(expected);
      expect(renderReplyText('内联 ``const `name` = "**raw**";  ``', 'plain')).toBe(
        '内联 const `name` = "**raw**";  '
      );
      await h.send({ replyId: 'literal', text });
      const body = h.queue.messages().find((row) => row.candidate.body)!.candidate;
      expect(body.body?.textFormat).toBe('plain');
      expect(body.body?.segments?.map((part) => part.text).join('')).toBe(expected);
      expect(
        h.probe.actions
          .at(-1)
          ?.nodes.flat()
          .map((node) => node.text ?? '')
          .join('')
      ).toBe(expected);
      expect(renderMessage(text, { msgType: 2, msgSeq: 1 }).markdown?.content).toContain(
        '```ts\n' + code + '```'
      );
      expect(renderMessage(expected, { msgType: 0, msgSeq: 1, preserveText: true }).content).toBe(
        expected
      );
    } finally {
      await h.close();
    }
  });

  it('引用渲染在投递历史和窗口保留真实代码且不泄漏内部问题号任务号', () => {
    const normal = { senderId: '10001', excerpt: 'const token = `q:example`; **原文**', ts: 1 };
    const quote = renderReference(normal);
    expect(quote).toBe('（引用 QQ 10001 的「const token = `q:example`; **原文**」）');
    expect(
      renderReplay([{ role: 'assistant', speaker: '助手', text: '回答', ts: 2, reference: normal }])
    ).toContain(quote);
    expect(
      renderWindowBlock([
        {
          msgId: 'reply',
          eventId: 'reply',
          addressed: false,
          senderId: 'bot',
          isBot: true,
          text: '回答',
          ts: 2,
          reference: normal,
        },
      ])
    ).toContain(quote);
    for (const excerpt of ['q:message@123', 'task:12345678-1234-1234-1234-123456789abc']) {
      const reference = { ...normal, excerpt };
      expect(renderReference(reference)).toBe('');
      expect(
        renderReplay([{ role: 'assistant', speaker: '助手', text: '回答', ts: 2, reference }])
      ).not.toContain(excerpt);
      expect(
        renderWindowBlock([
          {
            msgId: 'reply',
            eventId: 'reply',
            addressed: false,
            senderId: 'bot',
            isBot: true,
            text: '回答',
            ts: 2,
            reference,
          },
        ])
      ).not.toContain(excerpt);
    }
  });
  it('图片编码期间取消不会发出普通图文消息', async () => {
    const h = await deliveryHarness();
    try {
      const image = await h.file('cancelled.png', 'image bytes');
      const controller = new AbortController();
      const sent = h.probe.reply(
        { target: h.task.input.message.target, seq: 0, kind: 'final', signal: controller.signal },
        { text: '图片', attachments: [image] }
      );
      controller.abort();
      await expect(sent).rejects.toThrow();
      expect(h.probe.actions).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
