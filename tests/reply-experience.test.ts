import { afterEach, describe, expect, it } from 'vitest';
import { Harness, until } from './bench/session/harness.js';
import { OnebotProbe } from './bench/session/onebot-probe.js';
import { BusinessOutcome } from '../src/task/business-outcome.js';

const active: Harness[] = [];
const probes: OnebotProbe[] = [];
afterEach(async () => {
  for (const p of probes.splice(0)) await p.stop();
  for (const h of active.splice(0)) {
    await h.close();
    await h.remove();
  }
});
async function harness(record = false) {
  const h = await Harness.create();
  active.push(h);
  h.connector.recordCapable = record;
  return h;
}

describe('主动慢失败反馈边界', () => {
  it.each([false, true])(
    '快正文完整送达，record=%s：省略错误正文且保留状态、附件和预算',
    async (record) => {
      const h = await harness(record);
      const t = await h.submit({ text: '主动核查' }, true);
      const fast = await h.runtime(t.taskId, 'fast');
      fast.finish('已得到初步答案');
      await until(() =>
        h.system.queue.messages(t.taskId).some((r) => r.status === 'sent' && r.candidate.body)
      );
      await h.artifact(t, '附件内容');
      (await h.runtime(t.taskId, 'slow')).finish('查询失败', 'error');
      const task = await t.done;
      await h.idle();
      expect(task.status).toBe('failed');
      expect(task.lanes.slow.result).toMatchObject({
        kind: 'failed',
        errorId: expect.any(String),
        text: expect.stringContaining('查询失败'),
      });
      expect(h.received(t.taskId).some((a) => a.text.includes('任务执行失败'))).toBe(false);
      expect(h.received(t.taskId).some((a) => a.attachments.length > 0)).toBe(true);
      expect(h.system.budget.get(t.taskId)?.status).toBe('committed');
    }
  );
  it.each(['partial', 'failed', 'pending', 'silent', 'user'] as const)(
    '%s 时仍反馈慢错误',
    async (mode) => {
      const h = await harness();
      h.connector.maxChars = 4;
      const gate = h.defer();
      h.connector.send = async (_ctx, out) => {
        if (mode === 'partial' && out.text === '第二分段') throw new Error('partial');
        if (mode === 'pending' && out.text === '第一分段') await gate.promise;
      };
      const t = await h.submit({ text: '输入' }, mode !== 'user');
      const fast = await h.runtime(t.taskId, 'fast');
      fast.finish(
        mode === 'silent' ? 'NO_REPLY' : '第一分段第二分段',
        mode === 'failed' ? 'error' : 'completed'
      );
      await until(() => h.task(t.taskId).lanes.fast.status !== 'running');
      if (mode !== 'pending') await h.idle();
      (await h.runtime(t.taskId, 'slow')).finish('查询失败', 'error');
      await t.done;
      expect(
        h.system.queue
          .messages(t.taskId)
          .some(
            (r) => r.candidate.lane === 'slow' && r.candidate.kind === 'error' && r.candidate.body
          )
      ).toBe(true);
      gate.resolve();
      await h.idle();
      expect(h.task(t.taskId).status).toBe('failed');
    }
  );
  it('快正文送达后仍发送交付物的必需说明', async () => {
    const h = await harness();
    const t = await h.submit({ text: '主动附件' }, true);
    (await h.runtime(t.taskId, 'fast')).finish('初步结果');
    await h.idle();
    await h.artifact(t, '结果内容');
    (await h.runtime(t.taskId, 'slow')).finish('NO_REPLY');
    await t.done;
    await h.idle();
    expect(h.received(t.taskId).some((a) => a.text.includes('交付物但没有说明'))).toBe(true);
    expect(h.received(t.taskId).some((a) => a.attachments.length > 0)).toBe(true);
    expect(h.task(t.taskId).lanes.slow.result).toMatchObject({
      kind: 'failed',
      error: 'silent-with-deliverables',
    });
  });
});

describe('提醒标记和原引用', () => {
  it.each([false, true])(
    'record=%s：所有长度普通回复无 @，保留原引用和历史正文',
    async (record) => {
      const h = await harness(record);
      h.connector.maxChars = 16;
      const probe = new OnebotProbe(h.connector);
      probes.push(probe);
      await probe.start();
      for (const text of ['普通答复', '很长的答复'.repeat(20)]) {
        const t = await h.submit({ text: '原问题' });
        await h.finish(t, text, 'NO_REPLY');
        expect(h.system.queue.messages(t.taskId).every((r) => !r.candidate.mention)).toBe(true);
        expect(h.received(t.taskId)[0]?.reference?.messageId).toBe(
          h.task(t.taskId).input.reference.messageId
        );
        const replay = h.preparer.capture(h.message({ text: '下一问' })).replay;
        const bodies = h.system.queue.messages(t.taskId).filter((r) => r.candidate.body);
        expect(bodies.map((r) => r.candidate.text).join('')).toBe(text);
        expect(bodies.every((r) => replay.includes(r.candidate.text))).toBe(true);
      }
      expect(probe.actions.every((a) => a.nodes.flat().every((n) => n.type !== 'at'))).toBe(true);
    }
  );
  it.each([false, true])(
    'record=%s：强烈提醒只在首条正文/提示出现，附件与后续分段无 @',
    async (record) => {
      const h = await harness(record);
      h.connector.maxChars = 16;
      const probe = new OnebotProbe(h.connector);
      probes.push(probe);
      await probe.start();
      const t = await h.submit({ text: '原问题', sender: '10001' });
      const text = '需要你立即处理'.repeat(20);
      await h.artifact(t, '附件');
      await h.finish(t, `[REPLY_ATTENTION:strong]\n${text}`, `[REPLY_ATTENTION:strong]\n新增结论`);
      const mentions = probe.actions.flatMap((a) => a.nodes.flat()).filter((n) => n.type === 'at');
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.mention).toBe('10001');
      expect(h.system.queue.messages(t.taskId).filter((r) => r.candidate.mention)).toHaveLength(1);
      expect(
        h
          .received(t.taskId)
          .map((a) => a.text)
          .join('')
      ).not.toContain('REPLY_ATTENTION');
      expect(h.task(t.taskId).lanes.fast.result).toMatchObject({
        kind: 'reply',
        attention: 'strong',
        text,
      });
      expect(h.task(t.taskId).input.reference.senderId).toBe('10001');
    }
  );
  it.each(['missing-reference', 'middle-marker', 'private'] as const)(
    '%s 不生成 @ 且标记不泄漏',
    async (mode) => {
      const h = await harness(true);
      const t = await h.submit({
        text: '输入',
        ...(mode === 'private' ? { session: 'private-A' } : {}),
        ...(mode === 'missing-reference' ? { messageId: '' } : {}),
      });
      const text =
        mode === 'middle-marker'
          ? '开头\n[REPLY_ATTENTION:strong]\n正文'
          : '[REPLY_ATTENTION:strong]\n正文';
      await h.finish(t, text, 'NO_REPLY');
      expect(h.system.queue.messages(t.taskId).every((r) => !r.candidate.mention)).toBe(true);
      expect(
        h
          .received(t.taskId)
          .map((a) => a.text)
          .join('')
      ).not.toContain('REPLY_ATTENTION');
    }
  );
});

describe('真实 DSH 工具结果格式和独立业务收口', () => {
  it.each(['success', 'failed', 'unsettled', 'mismatch'] as const)(
    '%s 独立分类业务收口',
    (mode) => {
      const business = new BusinessOutcome();
      business.observe({
        seq: 1,
        type: 'tool/call',
        data: { callId: 'search-1', name: 'web_fetch', arguments: '{}' },
      });
      if (mode !== 'unsettled')
        business.observe({
          seq: 2,
          type: 'tool/result',
          data: {
            message: {
              source: { kind: 'tool', callId: mode === 'mismatch' ? 'other' : 'search-1' },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'search-1',
                  isError: mode === 'failed',
                  content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
                },
              ],
            },
          },
        });
      const failureReasons = {
        success: undefined,
        failed: 'query-failed',
        unsettled: 'tool-unsettled',
        mismatch: 'tool-unsettled',
      };
      expect(business.failureReason).toBe(failureReasons[mode]);
      expect(business.cannotBeSilent).toBe(mode !== 'success');
    }
  );
  it.each(['failed', 'unsettled'] as const)(
    '%s 的 NO_REPLY 反馈真实原因，保留失败状态',
    async (mode) => {
      const h = await harness();
      const t = await h.submit({ text: '查询' });
      const slow = await h.runtime(t.taskId, 'slow');
      slow.event('tool/call', { callId: 'fetch', name: 'web_fetch', arguments: '{}' });
      if (mode === 'failed')
        slow.event('tool/result', {
          message: {
            source: { kind: 'tool', callId: 'fetch' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'fetch',
                isError: true,
                content: [{ type: 'text', text: '失败' }],
              },
            ],
          },
        });
      await h.finish(t, '正在查询', 'NO_REPLY');
      expect(h.task(t.taskId).lanes.slow.result).toMatchObject({
        kind: 'failed',
        error: mode === 'failed' ? 'query-failed' : 'tool-unsettled',
      });
      expect(
        h
          .received(t.taskId)
          .map((a) => a.text)
          .join('')
      ).not.toContain('任务已执行');
    }
  );
});
