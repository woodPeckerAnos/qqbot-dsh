/**
 * 回复配额账本单测。
 *
 * 这是"5 分钟窗口 / 每条最多 5 次回复"这两个硬约束的守门人，
 * 一旦它算错，表现是用户永远收不到最终答案（进度回执把配额吃光）。
 */

import { describe, expect, it } from 'vitest';

import {
  ReplyLedger,
  ReplyQuotaExhaustedError,
  defaultProgressText,
} from '../src/pipeline/progress.js';

describe('ReplyLedger', () => {
  it('构造时拒绝 progressQuota >= totalQuota（否则最终答案没配额）', () => {
    expect(() => new ReplyLedger({ msgId: 'm', totalQuota: 3, progressQuota: 3 })).toThrow(
      /progressQuota 必须小于 totalQuota/,
    );
  });

  it('msg_seq 从 1 开始单调递增且不重复', () => {
    const ledger = new ReplyLedger({ msgId: 'm', totalQuota: 4, progressQuota: 2 });
    expect(ledger.allocate('progress').msgSeq).toBe(1);
    expect(ledger.allocate('final').msgSeq).toBe(2);
    expect(ledger.allocate('final').msgSeq).toBe(3);
    expect(new Set(ledger.usedSequences).size).toBe(3);
  });

  it('进度回执不能吃掉最终答案的配额', () => {
    const ledger = new ReplyLedger({ msgId: 'm', totalQuota: 4, progressQuota: 3 });
    expect(ledger.allocate('progress').msgSeq).toBe(1);
    expect(ledger.allocate('progress').msgSeq).toBe(2);
    expect(ledger.allocate('progress').msgSeq).toBe(3);
    // 此时只剩 1 条，必须留给最终答案
    expect(() => ledger.allocate('progress')).toThrow(ReplyQuotaExhaustedError);
    expect(ledger.canSendFinal).toBe(true);
    expect(ledger.allocate('final').msgSeq).toBe(4);
    expect(ledger.canSendFinal).toBe(false);
  });

  it('配额用尽后 final 分配也抛错', () => {
    const ledger = new ReplyLedger({ msgId: 'm', totalQuota: 2, progressQuota: 1 });
    ledger.allocate('final');
    ledger.allocate('final');
    expect(() => ledger.allocate('final')).toThrow(ReplyQuotaExhaustedError);
    expect(ledger.remaining).toBe(0);
  });

  it('remaining / progressRemaining 随着分配递减', () => {
    const ledger = new ReplyLedger({ msgId: 'm', totalQuota: 4, progressQuota: 2 });
    expect(ledger.remaining).toBe(4);
    expect(ledger.progressRemaining).toBe(2);
    ledger.allocate('progress');
    expect(ledger.remaining).toBe(3);
    expect(ledger.progressRemaining).toBe(1);
    ledger.allocate('final');
    expect(ledger.remaining).toBe(2);
    expect(ledger.progressRemaining).toBe(1);
  });

  it('默认配置（4 总额配 / 3 进度）符合官方"最多 5 次"的限制', () => {
    const ledger = new ReplyLedger({ msgId: 'm', totalQuota: 4, progressQuota: 3 });
    // 最多能发出 4 条，官方上限是 5，留了 1 条机动
    expect(ledger.total).toBeLessThan(5);
  });
});

describe('defaultProgressText', () => {
  it('包含已用时长', () => {
    const text = defaultProgressText(95_000, 0);
    expect(text).toContain('1 分 35 秒');
  });

  it('不足一分钟时用秒', () => {
    expect(defaultProgressText(30_000, 0)).toContain('30 秒');
  });

  it('有工具调用时显示次数', () => {
    expect(defaultProgressText(10_000, 3)).toContain('3 个操作');
  });
});
