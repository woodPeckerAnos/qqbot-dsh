import { OnebotProbe, digest } from './onebot-probe.js';
import type { BenchmarkCase } from './types.js';

const long = '结果完整交付。'.repeat(1500);
const definitions: {
  title: string;
  text: string;
  files?: string[];
  target: number;
  record?: boolean;
  zip?: boolean;
}[] = [
  { title: '阈值前', text: '甲'.repeat(1999), target: 1 },
  { title: '阈值等于', text: '甲'.repeat(2000), target: 1 },
  { title: '阈值后', text: '甲'.repeat(2001), target: 2, record: true },
  { title: '万字正文', text: long, target: 2, record: true },
  {
    title: '长代码块',
    text: '```ts\n' + 'const value = "中文";\n'.repeat(300) + '```',
    target: 2,
    record: true,
  },
  { title: '中文与emoji', text: '中文👩‍💻🙂'.repeat(400), target: 2, record: true },
  { title: '短代码块', text: '```ts\nconst answer = 42;\n```', target: 1 },
  { title: '单图', text: '', files: ['图.png'], target: 1 },
  { title: '短文单图', text: '图片说明', files: ['图.png'], target: 2 },
  { title: '长文单图', text: long, files: ['图.png'], target: 2, record: true },
  { title: '多图', text: '', files: ['甲.png', '乙.jpg'], target: 1, record: true },
  { title: '正文多图', text: '媒体说明', files: ['甲.png', '乙.jpg'], target: 2, record: true },
  { title: '多视频', text: '', files: ['甲.mp4', '乙.mp4'], target: 1, record: true },
  { title: '图片视频', text: '媒体说明', files: ['甲.png', '乙.mp4'], target: 2, record: true },
  { title: '单视频', text: '', files: ['甲.mp4'], target: 1 },
  { title: '长文单视频', text: long, files: ['甲.mp4'], target: 2, record: true },
  { title: '单文件', text: '', files: ['说明.txt'], target: 1 },
  { title: '普通多文件', text: '文件说明', files: ['甲.txt', '乙.csv'], target: 2, zip: true },
  { title: '混合附件', text: '文件说明', files: ['图.png', '说明.txt'], target: 2, zip: true },
  { title: '长文ZIP', text: long, files: ['甲.txt', '乙.csv'], target: 3, zip: true, record: true },
  { title: '非MP4视频归普通文件', text: '', files: ['甲.webm', '乙.mov'], target: 1, zip: true },
];

export const outputCases: BenchmarkCase[] = definitions.flatMap((d, index) =>
  ['group', 'private'].map((kind): BenchmarkCase => ({
    id: `D${String(index + 1).padStart(2, '0')}${kind === 'group' ? 'G' : 'P'}`,
    version: 1,
    group: '输出交付',
    title: `${kind}/${d.title}`,
    steps: [{ text: d.title }],
    expectation: '展示规则、原始正文与全部附件字节完整；外部条数按实际OneBot动作计',
    run: async (h) => {
      h.connector.recordCapable = true;
      const probe = new OnebotProbe(h.connector);
      await probe.start();
      try {
        const t = (await h.input({
          text: d.title,
          session: kind === 'private' ? 'private-12345' : '12345',
          sender: '10001',
        }))!;
        const slow = await h.runtime(t.taskId, 'slow');
        const files = (d.files ?? []).map((name) => ({
          name,
          bytes: `fixture:${h.seed}:${name}\n`,
        }));
        for (const file of files) await h.artifact(t, file.bytes, file.name);
        const preparedAt = performance.now();
        (await h.runtime(t.taskId, 'fast')).finish('NO_REPLY');
        slow.finish(d.text || 'NO_REPLY');
        await t.done;
        const preparationMs = performance.now() - preparedAt;
        await h.idle();
        const rows = h.system.queue.messages(t.taskId);
        const bodies = new Set(rows.filter((r) => r.candidate.body).map((r) => r.id));
        const actualBody = probe.actions
          .filter((a) => bodies.has(a.messageId ?? ''))
          .flatMap((a) =>
            a.nodes
              .flat()
              .filter((n) => n.type === 'text')
              .map((n) => n.text ?? '')
          )
          .join('');
        const entries = probe.actions.flatMap((a) => a.zipEntries ?? []);
        const media = probe.actions.flatMap((a) => a.nodes.flat().filter((n) => n.sha256));
        const filesComplete =
          files.every((file) =>
            (d.zip ? entries : media).some(
              (n) =>
                n.sha256 === digest(file.bytes) && n.sizeBytes === Buffer.byteLength(file.bytes)
            )
          ) && (d.zip ? entries.length : media.length) === files.length;
        const records = probe.actions.filter((a) => a.action.includes('forward'));
        const slowResult = h.task(t.taskId).lanes.slow.result;
        const originalFiles =
          slowResult && 'attachments' in slowResult ? (slowResult.attachments ?? []) : [];
        const expectedMedia = originalFiles.map((f) => ({
          type: mediaType(f.fileName),
          sha256: digest(files.find((input) => input.name === f.fileName)!.bytes),
        }));
        const mediaOrderPass =
          d.zip ||
          JSON.stringify(media.map(({ type, sha256 }) => ({ type, sha256 }))) ===
            JSON.stringify(expectedMedia);
        const flatPass = records.every(
          (a) =>
            a.nodes.every(
              (node) => node.length === 1 && ['text', 'image', 'video'].includes(node[0]!.type)
            ) && a.senderIds?.every((id) => id === '10000')
        );
        const routePass = probe.actions.every((a) =>
          kind === 'private' ? /private/.test(a.action) : /group/.test(a.action)
        );
        const tipParts = probe.actions[0]?.nodes.flat() ?? [];
        const tipPass =
          !d.text ||
          (tipParts.some(
            (n) => n.type === 'reply' && n.id === h.task(t.taskId).input.reference.messageId
          ) &&
            (kind === 'private'
              ? !tipParts.some((n) => n.type === 'at')
              : tipParts.some((n) => n.mention === '10001')));
        const displayPass =
          probe.actions.length === d.target &&
          records.length === Number(!!d.record) &&
          (d.zip ? entries.length === files.length : !entries.length) &&
          mediaOrderPass &&
          flatPass &&
          routePass &&
          tipPass;
        h.check(
          'output-display-rules',
          displayPass,
          {
            actual: probe.actions.length,
            target: d.target,
            records: records.length,
            gap: probe.actions.length - d.target,
          },
          'semantic'
        );
        h.check(
          'output-body-complete',
          actualBody === d.text,
          { expectedHash: digest(d.text), actualHash: digest(actualBody) },
          'semantic'
        );
        h.check('output-files-complete', filesComplete, { files, media, entries }, 'semantic');
        h.outputDelivery = {
          version: 1,
          inputHash: digest(JSON.stringify({ text: d.text, files })),
          externalMessages: probe.actions.length,
          targetMessages: d.target,
          internalNodes: records.reduce((sum, a) => sum + a.nodes.length, 0),
          actions: probe.actions,
          bodyComplete: actualBody === d.text,
          filesComplete,
          displayPass,
          preparationMs,
          lastDeliveryMs: Math.max(
            0,
            ...probe.actions.map((a) => (a.receivedAt ?? a.at) - h.task(t.taskId).createdAt)
          ),
        };
      } finally {
        await probe.stop();
        h.outputProbeListeners = probe
          .eventNames()
          .reduce((sum, name) => sum + probe.listenerCount(name), 0);
      }
    },
  }))
);

function mediaType(fileName: string) {
  if (/\.(png|jpg)$/i.test(fileName)) return 'image';
  return /\.mp4$/i.test(fileName) ? 'video' : 'file';
}
