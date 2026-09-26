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
  CN_HOLIDAYS_2026,
  DAY_MINUTES,
  dateStringInTimeZone,
  evaluateGate,
  formatMinutes,
  formatWindow,
  formatWindows,
  isInOffpeakWindow,
  isInOffpeakWindows,
  isValidDateString,
  isValidTimeZone,
  isWeekendInTimeZone,
  minutesInTimeZone,
  OffpeakConfigError,
  OffpeakGate,
  commandNeedsAdmin,
  parseOffpeakCommand,
  parseTimeHHMM,
  parseWindowRange,
  parseWindowsSpec,
  renderGateNotice,
  type OffpeakGateConfig,
} from '../src/offpeak/index.js';

// 2026-01-15 是周四。以下常量都是「北京时间 → UTC」的换算，不依赖宿主时区。
// 正价时段（09:00–12:00 / 14:00–18:00）：
const SHANGHAI_PEAK_MORNING = Date.UTC(2026, 0, 15, 2, 0); // 10:00
const SHANGHAI_PEAK_AFTERNOON = Date.UTC(2026, 0, 15, 8, 0); // 16:00
// 谷时段（00:00–09:00 / 12:00–14:00 / 18:00–24:00）：
const SHANGHAI_OFFPEAK_DAWN = Date.UTC(2026, 0, 14, 18, 0); // 02:00
const SHANGHAI_OFFPEAK_NOON = Date.UTC(2026, 0, 15, 4, 30); // 12:30
const SHANGHAI_OFFPEAK_EVENING = Date.UTC(2026, 0, 15, 12, 0); // 20:00
// 窗口边界（[start, end) 语义）：
const SHANGHAI_0900 = Date.UTC(2026, 0, 15, 1, 0); // 09:00 → 正价段起点
const SHANGHAI_NEXT_MIDNIGHT = Date.UTC(2026, 0, 15, 16, 0); // 次日 00:00 → 属第一个窗口

/** 2026-01-15 12:00 北京时间（周四）。日期/星期类用例只看日期，不看是否谷时段。 */
const SHANGHAI_NOON = Date.UTC(2026, 0, 15, 4, 0);

/** 内置默认的三个窗口：北京 00:00–09:00、12:00–14:00、18:00–24:00。 */
const DEFAULT_WINDOWS = [
  { startMin: 0, endMin: 9 * 60 },
  { startMin: 12 * 60, endMin: 14 * 60 },
  { startMin: 18 * 60, endMin: DAY_MINUTES },
] as const;

const DEFAULT_CONFIG: OffpeakGateConfig = {
  enabled: true,
  windows: [...DEFAULT_WINDOWS],
  timeZone: 'Asia/Shanghai',
  modelPattern: 'deepseek',
  weekendsAllDay: true,
  holidays: new Set(CN_HOLIDAYS_2026),
};

// 2026-01-17 是周六：04:00 UTC = 12:00 北京时间（周末正午）
const SHANGHAI_SATURDAY_NOON = Date.UTC(2026, 0, 17, 4, 0);
// 2026-01-17 周六 10:00 北京时间（正价段，用于验证 weekendsAllDay=false 时回落到窗口判定）
const SHANGHAI_SATURDAY_PEAK = Date.UTC(2026, 0, 17, 2, 0);
// 2026-10-01 是周四（国庆）：04:00 UTC = 12:00 北京时间（节假日正午）
const SHANGHAI_NATIONAL_DAY_NOON = Date.UTC(2026, 9, 1, 4, 0);
// 2026-09-20 是调休上班的周日：04:00 UTC = 12:00 北京时间
const SHANGHAI_ADJUSTED_SUNDAY_NOON = Date.UTC(2026, 8, 20, 4, 0);

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

  it('endMin = 24:00（DAY_MINUTES）表示当天结束', () => {
    const evening = { startMin: 18 * 60, endMin: DAY_MINUTES };
    expect(isInOffpeakWindow(17 * 60 + 59, evening)).toBe(false);
    expect(isInOffpeakWindow(18 * 60, evening)).toBe(true);
    expect(isInOffpeakWindow(23 * 60 + 59, evening)).toBe(true);
    // 次日 00:00 属于"新的一天"，不在 18:00–24:00 里
    expect(isInOffpeakWindow(0, evening)).toBe(false);
  });

  it('isInOffpeakWindows 命中任意一个窗口即算谷时段', () => {
    expect(isInOffpeakWindows(2 * 60, [...DEFAULT_WINDOWS])).toBe(true);
    expect(isInOffpeakWindows(12 * 60 + 30, [...DEFAULT_WINDOWS])).toBe(true);
    expect(isInOffpeakWindows(20 * 60, [...DEFAULT_WINDOWS])).toBe(true);
    expect(isInOffpeakWindows(10 * 60, [...DEFAULT_WINDOWS])).toBe(false);
    expect(isInOffpeakWindows(16 * 60, [...DEFAULT_WINDOWS])).toBe(false);
  });

  it('多窗口边界严格遵循 [start, end)', () => {
    const w = [...DEFAULT_WINDOWS];
    // 第一个窗口 00:00–09:00
    expect(isInOffpeakWindows(0, w)).toBe(true);
    expect(isInOffpeakWindows(8 * 60 + 59, w)).toBe(true);
    expect(isInOffpeakWindows(9 * 60, w)).toBe(false); // 09:00 起是正价
    // 第二个窗口 12:00–14:00
    expect(isInOffpeakWindows(11 * 60 + 59, w)).toBe(false);
    expect(isInOffpeakWindows(12 * 60, w)).toBe(true);
    expect(isInOffpeakWindows(13 * 60 + 59, w)).toBe(true);
    expect(isInOffpeakWindows(14 * 60, w)).toBe(false); // 14:00 起是正价
    // 第三个窗口 18:00–24:00
    expect(isInOffpeakWindows(17 * 60 + 59, w)).toBe(false);
    expect(isInOffpeakWindows(18 * 60, w)).toBe(true);
    expect(isInOffpeakWindows(23 * 60 + 59, w)).toBe(true);
    // 24:00 结束的窗口不覆盖次日 00:00，但那属于第一个窗口
    expect(isInOffpeakWindows(0, w)).toBe(true);
  });
});

describe('parseWindowRange / parseWindowsSpec / formatWindows', () => {
  it('解析单个窗口，连接符与空白都容忍', () => {
    const expected = { startMin: 9 * 60, endMin: 18 * 60 };
    expect(parseWindowRange('09:00-18:00')).toEqual(expected);
    expect(parseWindowRange('09:00 – 18:00')).toEqual(expected);
    expect(parseWindowRange('09:00~18:00')).toEqual(expected);
    expect(parseWindowRange('09:00—18:00')).toEqual(expected);
  });

  it('结束时间接受 24:00，开始时间不接受', () => {
    expect(parseWindowRange('18:00-24:00')).toEqual({ startMin: 18 * 60, endMin: DAY_MINUTES });
    expect(() => parseWindowRange('24:00-06:00')).toThrow(OffpeakConfigError);
  });

  it('拒绝空窗口与非法格式', () => {
    expect(() => parseWindowRange('08:30-08:30')).toThrow(/空窗口/);
    expect(() => parseWindowRange('没有横杠')).toThrow(OffpeakConfigError);
    expect(() => parseWindowRange('25:00-26:00')).toThrow(/超出范围/);
  });

  it('解析内置默认串，顺序按开始时间归一', () => {
    const parsed = parseWindowsSpec('00:00-09:00,12:00-14:00,18:00-24:00');
    expect(parsed).toEqual([...DEFAULT_WINDOWS]);
    // 乱序输入会被排序，保证渲染与比较稳定
    expect(parseWindowsSpec('18:00-24:00,00:00-09:00')).toEqual([
      { startMin: 0, endMin: 9 * 60 },
      { startMin: 18 * 60, endMin: DAY_MINUTES },
    ]);
  });

  it('逗号、中英文逗号、空白分隔、连接符带空格都能解析', () => {
    const expected = [...DEFAULT_WINDOWS];
    expect(parseWindowsSpec('00:00-09:00,12:00-14:00,18:00-24:00')).toEqual(expected);
    expect(parseWindowsSpec('00:00-09:00，12:00-14:00，18:00-24:00')).toEqual(expected);
    expect(parseWindowsSpec('00:00-09:00 12:00-14:00 18:00-24:00')).toEqual(expected);
    expect(parseWindowsSpec(' 00:00 – 09:00 , 12:00 – 14:00 , 18:00 – 24:00 ')).toEqual(expected);
    // 多余逗号/空白被忽略
    expect(parseWindowsSpec('00:00-09:00,,  12:00-14:00,')).toEqual([
      { startMin: 0, endMin: 9 * 60 },
      { startMin: 12 * 60, endMin: 14 * 60 },
    ]);
  });

  it('拒绝空串与重叠窗口', () => {
    expect(() => parseWindowsSpec('')).toThrow(OffpeakConfigError);
    expect(() => parseWindowsSpec(' , , ')).toThrow(/不能为空/);
    expect(() => parseWindowsSpec('00:00-09:00,08:00-12:00')).toThrow(/重叠/);
    // 完全相同的窗口也算重叠
    expect(() => parseWindowsSpec('00:00-09:00,00:00-09:00')).toThrow(/重叠/);
    // 跨零点窗口与早间窗口的重叠也要抓到（22:00-06:00 覆盖 00:00-06:00）
    expect(() => parseWindowsSpec('22:00-06:00,00:00-09:00')).toThrow(/重叠/);
    // 相邻但不重叠是可以的
    expect(parseWindowsSpec('00:00-09:00,09:00-12:00')).toHaveLength(2);
  });

  it('formatWindow / formatWindows 用 en dash 与顿号', () => {
    expect(formatWindow({ startMin: 0, endMin: 9 * 60 })).toBe('00:00–09:00');
    expect(formatWindow({ startMin: 18 * 60, endMin: DAY_MINUTES })).toBe('18:00–24:00');
    expect(formatWindows([...DEFAULT_WINDOWS])).toBe('00:00–09:00、12:00–14:00、18:00–24:00');
  });
});

describe('evaluateGate', () => {
  const base = { config: DEFAULT_CONFIG, provider: 'deepseek-official', model: 'deepseek-flash' };

  it('正价时段拦截（09:00–12:00 与 14:00–18:00）', () => {
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_PEAK_MORNING })).toEqual({
      gated: true,
      reason: 'peak-hours',
    });
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_PEAK_AFTERNOON })).toEqual({
      gated: true,
      reason: 'peak-hours',
    });
  });

  it('三个谷时段窗口内都放行', () => {
    for (const now of [
      SHANGHAI_OFFPEAK_DAWN,
      SHANGHAI_OFFPEAK_NOON,
      SHANGHAI_OFFPEAK_EVENING,
    ]) {
      expect(evaluateGate({ ...base, isAdmin: false, now })).toEqual({
        gated: false,
        reason: 'in-window',
      });
    }
  });

  it('窗口边界：起点算谷内，终点算谷外', () => {
    // 00:00 是第一个窗口的起点（谷内）；09:00 是它的终点（正价）
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_NEXT_MIDNIGHT }).gated).toBe(false);
    expect(evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_0900 })).toEqual({
      gated: true,
      reason: 'peak-hours',
    });
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

  it('周六全天谷价（DeepSeek 2026-08-23 起规则），周末中午不拦', () => {
    const decision = evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_SATURDAY_NOON });
    expect(decision).toEqual({ gated: false, reason: 'weekend' });
  });

  it('调休上班的周末仍是周六/日，自动被周末规则覆盖（2026-09-20 周日上班）', () => {
    const decision = evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_ADJUSTED_SUNDAY_NOON });
    expect(decision).toEqual({ gated: false, reason: 'weekend' });
  });

  it('法定节假日全天谷价（2026-10-01 周四，国庆），工作日的中午也不拦', () => {
    const decision = evaluateGate({ ...base, isAdmin: false, now: SHANGHAI_NATIONAL_DAY_NOON });
    expect(decision).toEqual({ gated: false, reason: 'holiday' });
  });

  it('weekendsAllDay=false 时周末回到时间窗口判定', () => {
    const config = { ...DEFAULT_CONFIG, weekendsAllDay: false };
    // 周末正午（12:00–14:00 是谷时段）→ 放行
    expect(
      evaluateGate({ ...base, config, isAdmin: false, now: SHANGHAI_SATURDAY_NOON }),
    ).toEqual({ gated: false, reason: 'in-window' });
    // 周末上午 10:00 是正价段 → 拦截
    expect(
      evaluateGate({ ...base, config, isAdmin: false, now: SHANGHAI_SATURDAY_PEAK }),
    ).toEqual({ gated: true, reason: 'peak-hours' });
  });

  it('模型不匹配时不拦（大小写不敏感，匹配 provider/model 组合）', () => {
    const decision = evaluateGate({
      ...base,
      provider: 'openai',
      model: 'gpt-5',
      isAdmin: false,
      now: SHANGHAI_PEAK_MORNING,
    });
    expect(decision).toEqual({ gated: false, reason: 'model-mismatch' });

    const upper = evaluateGate({
      ...base,
      model: 'DeepSeek-Flash',
      isAdmin: false,
      now: SHANGHAI_PEAK_MORNING,
    });
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

  it('setEnabled/setWindows 立即生效并持久化，重启（重建实例）后保留', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    const updated = gate.setWindows(parseWindowsSpec('23:00-07:00,12:00-14:00'), 'ADMIN-1');
    expect(updated.enabled).toBe(false);
    expect(gate.effective().windows).toEqual([
      { startMin: 12 * 60, endMin: 14 * 60 },
      { startMin: 23 * 60, endMin: 7 * 60 },
    ]);

    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective().enabled).toBe(false);
    expect(revived.effective().windows).toEqual([
      { startMin: 12 * 60, endMin: 14 * 60 },
      { startMin: 23 * 60, endMin: 7 * 60 },
    ]);
    expect(revived.snapshot()).toMatchObject({ overridden: true, updatedBy: 'ADMIN-1' });
  });

  it('持久化的窗口写成可读的 HH:MM 列表（24:00 也能往返）', () => {
    const gate = makeGate();
    gate.setWindows(parseWindowsSpec('18:00-24:00'), 'ADMIN-1');
    const file = JSON.parse(
      readFileSync(join(dir, 'offpeak-override.json'), 'utf8'),
    ) as { windows?: Array<{ start: string; end: string }> };
    expect(file.windows).toEqual([{ start: '18:00', end: '24:00' }]);

    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective().windows).toEqual([{ startMin: 18 * 60, endMin: DAY_MINUTES }]);
    expect(revived.snapshot().windows).toEqual(['18:00–24:00']);
  });

  it('读得懂旧格式的覆盖文件（单窗口 window 字段）', () => {
    const gate = makeGate();
    writeFileSync(
      join(dir, 'offpeak-override.json'),
      JSON.stringify({ window: { start: '00:30', end: '08:30' }, updatedBy: 'ADMIN-9' }),
      'utf8',
    );
    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective().windows).toEqual([{ startMin: 30, endMin: 8 * 60 + 30 }]);
    expect(revived.snapshot()).toMatchObject({ overridden: true, updatedBy: 'ADMIN-9' });
  });

  it('覆盖是逐项的：只覆盖 enabled 时窗口仍用默认', () => {
    const gate = makeGate();
    gate.setEnabled(false, 'ADMIN-1');
    expect(gate.effective().windows).toEqual(DEFAULT_CONFIG.windows);
  });

  it('setWindows 拒绝空窗口列表与重叠窗口', () => {
    const gate = makeGate();
    expect(() => gate.setWindows([], 'ADMIN-1')).toThrow(OffpeakConfigError);
    expect(() =>
      gate.setWindows(parseWindowsSpec('00:00-09:00'), 'ADMIN-1'),
    ).not.toThrow();
    // 重叠在 parseWindowsSpec 就被拦下（setWindows 只接受已解析结果，这里直接构造验证兜底）
    expect(() =>
      gate.setWindows(
        [
          { startMin: 0, endMin: 9 * 60 },
          { startMin: 8 * 60, endMin: 12 * 60 },
        ],
        'ADMIN-1',
      ),
    ).toThrow(/重叠/);
    expect(() => parseWindowsSpec('08:30-08:30')).toThrow(/空窗口/);
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
      action: 'set-windows',
      spec: '00:30-08:30',
    });
    expect(parseOffpeakCommand('/offpeak window 00:00-09:00,12:00-14:00,18:00-24:00')).toEqual({
      action: 'set-windows',
      spec: '00:00-09:00,12:00-14:00,18:00-24:00',
    });
  });

  it('容忍群聊 mention 前缀与多余空白', () => {
    expect(parseOffpeakCommand('<@!123456> /offpeak off')).toEqual({
      action: 'set-enabled',
      enabled: false,
    });
    expect(parseOffpeakCommand('  /offpeak   window  23:00 – 07:00 ')).toEqual({
      action: 'set-windows',
      spec: '23:00 – 07:00',
    });
  });

  it('不是命令的消息返回 undefined', () => {
    expect(parseOffpeakCommand('帮我写个脚本')).toBeUndefined();
    expect(parseOffpeakCommand('/offpeaking 是什么')).toBeUndefined();
    expect(parseOffpeakCommand('记得 /offpeak off 就行')).toBeUndefined();
  });

  it('窗口串只做非空检查，真正的解析交给 parseWindowsSpec（错误由编排层回"设置失败"）', () => {
    // 结构不对的子命令（缺参数 / 未知子命令）在解析期就判 invalid
    expect(parseOffpeakCommand('/offpeak window')?.action).toBe('invalid');
    expect(parseOffpeakCommand('/offpeak explode')?.action).toBe('invalid');

    // 窗口内容非法则原样透传，由 parseWindowsSpec 抛 OffpeakConfigError
    const command = parseOffpeakCommand('/offpeak window 没有横杠');
    expect(command).toEqual({ action: 'set-windows', spec: '没有横杠' });
    expect(() => parseWindowsSpec('没有横杠')).toThrow(OffpeakConfigError);
  });

  it('权限标注：变更类需要管理员，查询类不需要', () => {
    expect(commandNeedsAdmin({ action: 'status' })).toBe(false);
    expect(commandNeedsAdmin({ action: 'whoami' })).toBe(false);
    expect(commandNeedsAdmin({ action: 'set-enabled', enabled: false })).toBe(true);
    expect(commandNeedsAdmin({ action: 'set-windows', spec: '00:30-08:30' })).toBe(true);
    expect(commandNeedsAdmin({ action: 'reset' })).toBe(true);
  });
});

describe('renderGateNotice', () => {
  it('提示文案包含生效的窗口与时区，不写死', () => {
    const text = renderGateNotice({
      ...DEFAULT_CONFIG,
      windows: [
        { startMin: 23 * 60, endMin: 7 * 60 },
        { startMin: 12 * 60, endMin: 14 * 60 },
      ],
      timeZone: 'Asia/Shanghai',
    });
    expect(text).toContain('23:00–07:00');
    expect(text).toContain('12:00–14:00');
    expect(text).toContain('Asia/Shanghai');
    expect(text).toContain('正价时段');
  });
});

describe('日期工具', () => {
  it('dateStringInTimeZone 按指定时区取日历日期', () => {
    // 2026-01-15 04:00 UTC 在上海是 1 月 15 日，在 UTC-12 还是 1 月 14 日
    expect(dateStringInTimeZone(SHANGHAI_NOON, 'Asia/Shanghai')).toBe('2026-01-15');
    expect(dateStringInTimeZone(SHANGHAI_NOON, 'Etc/GMT+12')).toBe('2026-01-14');
  });

  it('isWeekendInTimeZone 判定周六周日', () => {
    expect(isWeekendInTimeZone(SHANGHAI_SATURDAY_NOON, 'Asia/Shanghai')).toBe(true);
    expect(isWeekendInTimeZone(SHANGHAI_NOON, 'Asia/Shanghai')).toBe(false); // 周四
  });

  it('isValidDateString 拒绝不存在的日期', () => {
    expect(isValidDateString('2026-10-01')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('10月1日')).toBe(false);
  });
});

describe('OffpeakGate 节假日增删', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeGate() {
    dir = mkdtempSync(join(tmpdir(), 'qqbot-offpeak-holiday-'));
    return new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
      now: () => 1234567890,
    });
  }

  it('addHoliday 追加跨年日期并持久化，重建后保留', () => {
    const gate = makeGate();
    gate.addHoliday('2027-01-01', 'ADMIN-1');
    expect(gate.effective().holidays.has('2027-01-01')).toBe(true);
    expect(gate.snapshot().holidaysCoverageUntil).toBe('2027-01-01');

    const revived = new OffpeakGate({
      defaults: DEFAULT_CONFIG,
      filePath: join(dir, 'offpeak-override.json'),
      logger: createNullLogger(),
    });
    expect(revived.effective().holidays.has('2027-01-01')).toBe(true);
  });

  it('delHoliday 从内置官方表里移除日期', () => {
    const gate = makeGate();
    expect(gate.effective().holidays.has('2026-10-01')).toBe(true);
    gate.delHoliday('2026-10-01', 'ADMIN-1');
    expect(gate.effective().holidays.has('2026-10-01')).toBe(false);
    // 同表内其他日期不受影响
    expect(gate.effective().holidays.has('2026-10-02')).toBe(true);
  });

  it('add/del 拒绝非法日期', () => {
    const gate = makeGate();
    expect(() => gate.addHoliday('2026-02-30', 'ADMIN-1')).toThrow(OffpeakConfigError);
    expect(() => gate.delHoliday('国庆节', 'ADMIN-1')).toThrow(OffpeakConfigError);
  });

  it('snapshot 暴露窗口列表、周末规则与节假日覆盖范围', () => {
    const gate = makeGate();
    const snapshot = gate.snapshot();
    expect(snapshot.windows).toEqual(['00:00–09:00', '12:00–14:00', '18:00–24:00']);
    expect(snapshot.weekendsAllDay).toBe(true);
    expect(snapshot.holidaysCount).toBe(CN_HOLIDAYS_2026.length);
    expect(snapshot.holidaysCoverageUntil).toBe('2026-10-07');
  });
});

describe('parseOffpeakCommand 的 holiday 子命令', () => {
  it('识别 add/del/list', () => {
    expect(parseOffpeakCommand('/offpeak holiday add 2027-01-01')).toEqual({
      action: 'holiday-add',
      date: '2027-01-01',
    });
    expect(parseOffpeakCommand('/offpeak holiday del 2027-01-01')).toEqual({
      action: 'holiday-del',
      date: '2027-01-01',
    });
    expect(parseOffpeakCommand('/offpeak holiday list')).toEqual({ action: 'holiday-list' });
    expect(parseOffpeakCommand('/offpeak holiday')).toEqual({ action: 'holiday-list' });
  });

  it('参数不全返回 invalid', () => {
    expect(parseOffpeakCommand('/offpeak holiday add')?.action).toBe('invalid');
  });

  it('权限标注：add/del 需要管理员，list 不需要', () => {
    expect(commandNeedsAdmin({ action: 'holiday-add', date: '2027-01-01' })).toBe(true);
    expect(commandNeedsAdmin({ action: 'holiday-del', date: '2027-01-01' })).toBe(true);
    expect(commandNeedsAdmin({ action: 'holiday-list' })).toBe(false);
  });
});

describe('官方节假日表（CN_HOLIDAYS_2026）', () => {
  it('与国办发明电〔2025〕7 号通知逐条对应', () => {
    const set = new Set(CN_HOLIDAYS_2026);
    // 元旦 / 春节 / 清明 / 劳动节 / 端午 / 中秋 / 国庆
    expect(set.has('2026-01-01')).toBe(true);
    expect(set.has('2026-02-17')).toBe(true); // 正月初一
    expect(set.has('2026-02-23')).toBe(true); // 春节假期最后一天
    expect(set.has('2026-04-06')).toBe(true); // 清明调休日
    expect(set.has('2026-05-01')).toBe(true);
    expect(set.has('2026-06-19')).toBe(true); // 端午
    expect(set.has('2026-09-25')).toBe(true); // 中秋
    expect(set.has('2026-10-07')).toBe(true); // 国庆最后一天
    // 调休上班日绝不能出现在表里
    expect(set.has('2026-02-14')).toBe(false); // 春节调休上班（周六）
    expect(set.has('2026-09-20')).toBe(false); // 国庆调休上班（周日）
    // 每个日期都合法
    for (const date of CN_HOLIDAYS_2026) expect(isValidDateString(date)).toBe(true);
  });
});
