/**
 * 谷时段闸单测（纯函数 + 覆盖持久化，全离线）。
 *
 * 时区相关用例用固定 UTC 时间戳推算 Asia/Shanghai 的分钟数，
 * 不依赖运行环境的本地时区。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import {
  evaluateGate,
  formatMinutes,
  isInOffpeakWindow,
  isValidTimeZone,
  minutesInTimeZone,
  OffpeakConfigError,
  OffpeakGate,
  commandNeedsAdmin,
  parseOffpeakCommand,
  parseTimeHHMM,
  renderGateNotice,
  type OffpeakGateConfig,
} from '../src/offpeak.js';

// 2026-01-15 04:00 UTC = 2026-01-15 12:00 Asia/Shanghai（正价时段）
const SHANGHAI_NOON = Date.UTC(2026, 0, 15, 4, 0);
// 2026-01-14 18:00 UTC = 2026-01-15 02:00 Asia/Shanghai（谷时段内）
const SHANGHAI_2AM = Date.UTC(2026, 0, 14, 18, 0);
// 2026-01-14 16:30 UTC = 2026-01-15 00:30 Asia/Shanghai（窗口起点）
const SHANGHAI_WINDOW_START = Date.UTC(2026, 0, 14, 16, 30);
// 2026-01-15 00:30 UTC = 2026-01-15 08:30 Asia/Shanghai（窗口终点）
const SHANGHAI_WINDOW_END = Date.UTC(2026, 0, 15, 0, 30);

const DEFAULT_CONFIG: OffpeakGateConfig = {
  enabled: true,
  window: { startMin: 30, endMin: 510 }, // 00:30–08:30
  timeZone: 'Asia/Shanghai',
  modelPattern: 'deepseek',
};

describe('parseTimeHHMM / formatMinutes', () => {
  it('解析合法的 HH:MM', () => {
    expect(parseTimeHHMM('00:30')).toBe(30);
    expect(parseTimeHHMM('8:05')).toBe(485);
    expect(parseTimeHHMM('23:59')).toBe(1439);
  });

  it('拒绝非法输入', () => {
    expect(() => parseTimeHHMM('')).toThrow(OffpeakConfigError);
    expect(() => parseTimeHHMM('24:00')).toThrow(OffpeakConfigError);
    expect(() => parseTimeHHMM('08:60')).toThrow(OffpeakConfigError);
    expect(() => parseTimeHHMM('八点半')).toThrow(OffpeakConfigError);
  });

  it('formatMinutes 补齐前导零', () => {
    expect(formatMinutes(30)).toBe('00:30');
    expect(formatMinutes(510)).toBe('08:30');
  });
});

describe('时区换算', () => {
  it('按指定时区而非宿主时区计算一天中的分钟数', () => {
    expect(minutesInTimeZone(SHANGHAI_NOON, 'Asia/Shanghai')).toBe(12 * 60);
    expect(minutesInTimeZone(SHANGHAI_NOON, 'UTC')).toBe(4 * 60);
  });

  it('校验时区名', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('isInOffpeakWindow', () => {
  const window = { startMin: 30, endMin: 510 };

  it('区间为 [start, end)', () => {
    expect(isInOffpeakWindow(29, window)).toBe(false);
    expect(isInOffpeakWindow(30, window)).toBe(true);
    expect(isInOffpeakWindow(509, window)).toBe(true);
    expect(isInOffpeakWindow(510, window)).toBe(false);
  });

  it('支持跨零点窗口（如 22:00–06:00）', () => {
    const wrap = { startMin: 22 * 60, endMin: 6 * 60 };
    expect(isInOffpeakWindow(23 * 60, wrap)).toBe(true);
    expect(isInOffpeakWindow(0, wrap)).toBe(true);
    expect(isInOffpeakWindow(5 * 60 + 59, wrap)).toBe(true);
    expect(isInOffpeakWindow(6 * 60, wrap)).toBe(false);
    expect(isInOffpeakWindow(12 * 60, wrap)).toBe(false);
  });
});

describe('evaluateGate', () => {
  const base = { config: DEFAULT_CONFIG, provider: 'deepseek-official', model: 'deepseek-flash' };

  it('正价时段拦截', () => {
    const decision = evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_NOON });
    expect(decision).toEqual({ gated: true, reason: 'peak-hours' });
  });

  it('谷时段内放行', () => {
    const decision = evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_2AM });
    expect(decision).toEqual({ gated: false, reason: 'in-window' });
  });

  it('窗口边界：起点算谷内，终点算谷外', () => {
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_WINDOW_START }).gated).toBe(false);
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_WINDOW_END }).gated).toBe(true);
  });

  it('管理员任何时段都不被拦', () => {
    const decision = evaluateGate({ ...base, isAdmin: true, now: SHANGHAI_NOON });
    expect(decision).toEqual({ gated: false, reason: 'admin' });
  });

  it('闸关闭时不拦', () => {
    const decision = evaluateGate({
      ...base,
      config: { ...DEFAULT_CONFIG, enabled: false },
      isAdmin: false,
      now: SHANGHAI_NOON,
    });
    expect(decision).toEqual({ gated: false, reason: 'disabled' });
  });

  it('模型不匹配时不拦（大小写不敏感，匹配 provider/model 组合）', () => {
    const decision = evaluateGate({
      ...base,
      provider: 'openai',
      model: 'gpt-5',
      isAdmin: false,
      now: SHANGHAI_NOON,
    });
    expect(decision).toEqual({ gated: false, reason: 'model-mismatch' });

    const upper = evaluateGate({ ...base, model: 'DeepSeek-Flash', isAdmin: false, now: SHANGHAI_NOON });
    expect(upper.gated).toBe(true);
  });
});

describe('OffpeakGate（覆盖与持久化）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeGate() {
    dir = mkdtempSync(join(tmpdir(), 'qqbot-offpeak-'));
    return new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
      now: () => 1234567890,
    });
  }

  it('无覆盖时生效配置就是 env 默认', () => {
    const gate = makeGate();
    expect(gate.effective()).toEqual(DEFAULT_CONFIG);
    expect(gate.snapshot().overridden).toBe(false);
  });

  it('setEnabled/setWindow 立即生效并持久化，重启（重建实例）后保留', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    gate.setWindow('23:00', '07:00', 'ADMIN-1');
    expect(gate.effective().enabled).toBe(false);
    expect(gate.effective().window).toEqual({ startMin: 23 * 60, endMin: 7 * 60 });

    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective().enabled).toBe(false);
    expect(revived.effective().window).toEqual({ startMin: 23 * 60, endMin: 7 * 60 });
    expect(revived.snapshot()).toMatchObject({ overridden: true, updatedBy: 'ADMIN-1' });
  });

  it('覆盖是逐项的：只覆盖 enabled 时窗口仍用默认', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    expect(gate.effective().window).toEqual(DEFAULT_CONFIG.window);
  });

  it('setWindow 拒绝空窗口', () => {
    const gate = makeGate();
    expect(() => gate.setWindow('08:30', '08:30', 'ADMIN-1')).toThrow(OffpeakConfigError);
  });

  it('clearOverride 回到 env 默认', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    gate.clearOverride('ADMIN-1');
    expect(gate.effective()).toEqual(DEFAULT_CONFIG);
    expect(gate.snapshot().overridden).toBe(false);
  });

  it('覆盖文件损坏时告警并回落到默认，不炸启动', () => {
    const gate = makeGate();
    writeFileSync(join(dir, 'offpeak-override.json'), '{broken json', 'utf8');
    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective()).toEqual(DEFAULT_CONFIG);
    expect(gate.effective().enabled).toBe(true);
  });

  it('持久化文件是可读 JSON（便于人工排查）', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    const file = JSON.parse(readFileSync(join(dir, 'offpeak-override.json'), 'utf8')) as Record<string, unknown>;
    expect(file['enabled']).toBe(false);
    expect(file['updatedBy']).toBe('ADMIN-1');
  });
});

describe('parseOffpeakCommand', () => {
  it('识别各子命令', () => {
    expect(parseOffpeakCommand('/offpeak')).toEqual({ action: 'status' });
    expect(parseOffpeakCommand('/offpeak status')).toEqual({ action: 'status' });
    expect(parseOffpeakCommand('/offpeak whoami')).toEqual({ action: 'whoami' });
    expect(parseOffpeakCommand('/offpeak on')).toEqual({ action: 'set-enabled', enabled: true });
    expect(parseOffpeakCommand('/offpeak off')).toEqual({ action: 'set-enabled', enabled: false });
    expect(parseOffpeakCommand('/offpeak reset')).toEqual({ action: 'reset' });
    expect(parseOffpeakCommand('/offpeak window 00:30-08:30')).toEqual({
      action: 'set-window',
      start: '00:30',
      end: '08:30',
    });
  });

  it('容忍群聊 mention 前缀与多余空白', () => {
    expect(parseOffpeakCommand('<@!123456> /offpeak off')).toEqual({
      action: 'set-enabled',
      enabled: false,
    });
    expect(parseOffpeakCommand('  /offpeak   window  23:00 – 07:00 ')).toEqual({
      action: 'set-window',
      start: '23:00',
      end: '07:00',
    });
  });

  it('不是命令的消息返回 undefined', () => {
    expect(parseOffpeakCommand('帮我写个脚本')).toBeUndefined();
    expect(parseOffpeakCommand('/offpeaking 是什么')).toBeUndefined();
    expect(parseOffpeakCommand('记得 /offpeak off 就行')).toBeUndefined();
  });

  it('参数错误返回 invalid 而不是抛错', () => {
    const result = parseOffpeakCommand('/offpeak window 没有横杠');
    expect(result?.action).toBe('invalid');
    expect(parseOffpeakCommand('/offpeak explode')?.action).toBe('invalid');
  });

  it('权限标注：变更类需要管理员，查询类不需要', () => {
    expect(commandNeedsAdmin({ action: 'status' })).toBe(false);
    expect(commandNeedsAdmin({ action: 'whoami' })).toBe(false);
    expect(commandNeedsAdmin({ action: 'set-enabled', enabled: false })).toBe(true);
    expect(commandNeedsAdmin({ action: 'set-window', start: '00:30', end: '08:30' })).toBe(true);
    expect(commandNeedsAdmin({ action: 'reset' })).toBe(true);
  });
});

describe('renderGateNotice', () => {
  it('提示文案包含生效的窗口与时区，不写死', () => {
    const text = renderGateNotice({
      ...DEFAULT_CONFIG,
      window: { startMin: 23 * 60, endMin: 7 * 60 },
      timeZone: 'Asia/Shanghai',
    });
    expect(text).toContain('23:00–07:00');
    expect(text).toContain('Asia/Shanghai');
    expect(text).toContain('正价时段');
  });
});
