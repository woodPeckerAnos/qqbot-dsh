/**
 * 话题介入的每群共享状态。
 *
 * 归属与纪律（方案 §5.5）：
 *   - 本文件是唯一持有可变状态的地方；规则文件夹永远只见只读视图
 *     （`ConversationStateView`），改动状态的权力归 runner（watcher.ts）；
 *   - FOCUS/FADING/COLD 相位与迁移表在 Phase 2 加入，同样集中在本文件——
 *     迁移逻辑不散进规则文件夹，否则不可审计；
 *   - 缓冲与去重全内存：旁听数据的隐私默认值是「随进程消亡」（方案 §7.3），
 *     且绕开 SeenStore 的「一消息一文件」磁盘模型（活跃群会刷爆小文件目录）。
 */

import type { ConversationTarget, NormalizedObservedMessage } from '../core/connector.js';

/** 旁听缓冲里的一条消息。 */
export interface ObservedEntry {
  msgId: string;
  senderId: string;
  senderName?: string;
  text: string;
  ts: number;
  atOthers: boolean;
  quotedMsgId?: string;
  /**
   * 同 msgId 的 @ 消息到达时置真（官方全量模式下一条消息可能同时以
   * GROUP_AT_MESSAGE_CREATE 与 GROUP_MESSAGE_CREATE 到达；见方案 §12）。
   * 已 addressed 的条目不再参与介入评估。
   */
  addressed?: boolean;
}

/** pending 合并队列里的一条（41 号规则的 runner 侧落点，方案 §8.2）。 */
export interface PendingMergeEntry {
  message: NormalizedObservedMessage;
  /** 入队时刻（注入时钟；过期淘汰用） */
  enqueuedAt: number;
}

/** pending 队列的容量纪律（参数归规则 41 的 REQUIREMENT.md 所有，runner 执行）。 */
export interface PendingMergeLimits {
  /** 队列上限；超限丢最旧（计数归 runner） */
  maxEntries: number;
  /** 入队时淘汰比这更旧的条目；flush 时过期条目直接作废 */
  maxAgeMs: number;
}

/** 介入相位（方案 §9.3；迁移表集中在本文件，不散进规则文件夹）。 */
export type InterventionPhase = 'cold' | 'focus' | 'fading';

/** 相位迁移事件的参数（来自规则 31 的 params 生效值，由 runner 解析后传入）。 */
export interface PhaseDurations {
  focusMs: number;
  fadingMs: number;
  focusMaxReplies: number;
}

/** 相位迁移事件：只有这三种（方案 §5.5）。 */
export type PhaseEvent = 'spoke' | 'gate-silent' | 'rate-limit-hit';

/** 规则可见的只读视图。 */
export interface ConversationStateView {
  /** 会话键（如 ob11:g123456） */
  readonly key: string;
  /** 旁听缓冲，旧 → 新排列 */
  readonly entries: readonly ObservedEntry[];
  /** 内存去重查询（规则 04 用；eventId 带平台命名空间） */
  hasSeen(eventId: string): boolean;
  /** 运行期群开关（/listen on|off 写入；undefined = 未设置，跟随静态配置） */
  readonly runtimeEnabled: boolean | undefined;
  /**
   * 该发送者的续聊窗口截止时刻（40 号规则用；undefined = 未开窗）。
   * 窗口由 runner 在 @ turn 派发后打开、晋升后重置（方案 §8.1）。
   */
  continuationWindowUntil(senderId: string): number | undefined;
  /** 本会话当前是否有 turn 在途（41/32 号规则用；runner 在派发/结束时维护） */
  readonly inFlight: boolean;
  /** pending 合并队列只读视图，旧 → 新（41 号规则用） */
  readonly pendingMerge: readonly PendingMergeEntry[];
  /** 当前生效相位（懒过期：窗口期满自动视为 cold；方案 §9.3） */
  phaseAt(now: number): InterventionPhase;
  /** FOCUS 相位内已主动发言次数（31 号规则用；相位过期视为 0） */
  focusSpokeCountAt(now: number): number;
  /** 上次进入 evaluate 链的时刻（08 号规则的冷却判定用；undefined = 从未评估） */
  readonly lastEvaluateAt: number | undefined;
  /** 自上次评估以来入缓冲的条数（13 号规则的采样计数用） */
  readonly unevaluatedCount: number;
  /** 近 windowMs 内（now-windowMs 之后）的介入发言次数（07/30 号规则用） */
  countSpokeSince(sinceTs: number): number;
  /** bot 最近一次发言时刻（09 号规则用；runner 在 turn 交付时记账） */
  readonly botLastSpokeAt: number | undefined;
  /** 某 msgId 是否为 bot 近期发过的消息（10 号规则用） */
  botHasSpoken(msgId: string): boolean;
  /** bot 上次发言提取的实词关键词（12 号规则用；最多 20 个） */
  readonly botKeywords: readonly string[];
}

/** 缓冲配置。 */
export interface BufferLimits {
  maxMessages: number;
  maxAgeMs: number;
}

/** 内存 LRU 去重集（防框架重连重放；容量超出淘汰最旧）。 */
export class LruSet {
  private readonly items = new Set<string>();
  constructor(private readonly capacity: number) {}

  /** 已存在返回 true；不存在则记录并返回 false。 */
  claim(id: string): boolean {
    if (id === '') return false;
    if (this.items.has(id)) return true;
    this.items.add(id);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    return false;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }
}

/** 一个群的完整可变状态（runner 专用；规则经 ConversationStateView 只读访问）。 */
export class ConversationWatchState implements ConversationStateView {
  readonly key: string;
  /** 会话寻址（runner 合成介入 turn 时用；首个消息到达时记录） */
  target?: ConversationTarget;
  /** 旧 → 新；超出容量/年龄从头部淘汰 */
  readonly entries: ObservedEntry[] = [];
  readonly seen = new LruSet(500);
  runtimeEnabled: boolean | undefined = undefined;
  /** 续聊窗口：senderId → 截止时刻（过期即失效，读取方比较 now） */
  private readonly continuationWindows = new Map<string, number>();
  /** 本会话是否有 turn 在途（runner 在派发/结束时维护） */
  inFlight = false;
  /** pending 合并队列（41 号规则的 runner 侧落点），旧 → 新 */
  readonly pendingMerge: PendingMergeEntry[] = [];
  /** 相位（懒过期：读取时按 now 归一化） */
  private phase: InterventionPhase = 'cold';
  private phaseUntil = 0;
  private focusSpokeCount = 0;
  private consecutiveGateSilent = 0;
  /** 介入发言时刻（滑动限流窗口：10min/1h；只记主动介入，不含 @ 回复） */
  private spokeAt: number[] = [];
  /** 上次进入 evaluate 链的时刻 */
  lastEvaluateAt: number | undefined = undefined;
  /** 自上次评估以来入缓冲的条数（13 号规则采样用） */
  unevaluatedCount = 0;
  /** bot 最近一次发言时刻（@ 回复与介入都算；09 号规则用） */
  botLastSpokeAt: number | undefined = undefined;
  /** bot 近期发言的 msgId 集（10 号规则用；官方通道回传，OneBot 通常拿不到） */
  private readonly botMsgIds = new LruSet(50);
  /** bot 上次发言提取的实词关键词（12 号规则用） */
  botKeywords: string[] = [];

  constructor(
    key: string,
    private readonly limits: BufferLimits,
  ) {
    this.key = key;
  }

  /** 内存去重查询（ConversationStateView）。 */
  hasSeen(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** 续聊窗口查询（ConversationStateView）。 */
  continuationWindowUntil(senderId: string): number | undefined {
    return this.continuationWindows.get(senderId);
  }

  /**
   * runner：把一条消息追加进缓冲（同时按容量与年龄淘汰，并累计未评估计数）。
   * 幂等：eventId 已认领（入过缓冲/晋升过/入过合并队列）则跳过——
   * 定时器重入（answer-window）不会让同一条消息重复进缓冲。
   */
  pushEntry(message: NormalizedObservedMessage, now: number): void {
    if (this.seen.claim(message.eventId)) return;
    this.target ??= message.target;
    const entry: ObservedEntry = {
      msgId: message.msgId,
      senderId: message.senderId,
      ...(message.username !== undefined ? { senderName: message.username } : {}),
      text: message.content,
      ts: message.ts,
      atOthers: message.atOthers,
      ...(message.quotedMsgId !== undefined ? { quotedMsgId: message.quotedMsgId } : {}),
    };
    this.entries.push(entry);
    this.unevaluatedCount += 1;
    const cutoff = now - this.limits.maxAgeMs;
    while (this.entries.length > this.limits.maxMessages) this.entries.shift();
    while (this.entries.length > 0 && this.entries[0]!.ts < cutoff) this.entries.shift();
  }

  /** runner：把缓冲里指定 msgId 的条目标记为「已被 @ 路径处理」。 */
  markAddressed(msgId: string): void {
    for (const entry of this.entries) {
      if (entry.msgId === msgId) entry.addressed = true;
    }
  }

  /** runner：@ turn 派发后开窗 / 晋升后重置（方案 §8.1：每次晋升后重置）。 */
  openContinuationWindow(senderId: string, until: number): void {
    this.continuationWindows.set(senderId, until);
  }

  /**
   * runner：入队一条待合并的晋升消息。入队即认领 eventId（防重放双晋升）；
   * 先淘汰过期条目，再按容量丢最旧。返回被淘汰的条数（计数归 runner）。
   */
  enqueuePending(message: NormalizedObservedMessage, now: number, limits: PendingMergeLimits): number {
    this.seen.claim(message.eventId);
    const cutoff = now - limits.maxAgeMs;
    let evicted = 0;
    while (this.pendingMerge.length > 0 && this.pendingMerge[0]!.enqueuedAt < cutoff) {
      this.pendingMerge.shift();
      evicted += 1;
    }
    while (this.pendingMerge.length >= limits.maxEntries) {
      this.pendingMerge.shift();
      evicted += 1;
    }
    this.pendingMerge.push({ message, enqueuedAt: now });
    return evicted;
  }

  /** runner：取空 pending 队列（turn 结束后的冲刷；返回旧 → 新）。 */
  drainPending(): PendingMergeEntry[] {
    return this.pendingMerge.splice(0, this.pendingMerge.length);
  }

  // ---------------------------------------------------------------------------
  // 以下为 Phase 2 的 runner 侧记账与相位迁移（迁移表 = 唯一真相，方案 §5.5/§9.3）
  // ---------------------------------------------------------------------------

  /** 当前生效相位（懒过期，不改内部状态） */
  phaseAt(now: number): InterventionPhase {
    if (this.phase !== 'cold' && now >= this.phaseUntil) return 'cold';
    return this.phase;
  }

  /** FOCUS 相位内已主动发言次数（相位过期视为 0） */
  focusSpokeCountAt(now: number): number {
    return this.phaseAt(now) === 'focus' ? this.focusSpokeCount : 0;
  }

  /** 近 windowMs 内的介入发言次数（滑动窗口） */
  countSpokeSince(sinceTs: number): number {
    let count = 0;
    for (const ts of this.spokeAt) if (ts >= sinceTs) count += 1;
    return count;
  }

  botHasSpoken(msgId: string): boolean {
    return this.botMsgIds.has(msgId);
  }

  /** runner：进入 evaluate 链时记账（冷却与采样计数的原点）。 */
  recordEvaluate(now: number): void {
    this.lastEvaluateAt = now;
    this.unevaluatedCount = 0;
  }

  /** runner：bot 发出了可见回复（@ 回复或介入）时记账（09/12 号规则的输入）。 */
  noteBotSpeech(now: number, text: string, msgIds: readonly string[] = []): void {
    this.botLastSpokeAt = now;
    this.botKeywords = extractKeywords(text);
    for (const id of msgIds) this.botMsgIds.claim(id);
  }

  /**
   * 相位迁移表（方案 §9.3）：
   *   spoke          cold→focus（开窗，计数 1）；focus→focus（计数 +1，续窗；
   *                  计数满 focusMaxReplies → fading）；fading→fading（续窗）
   *   gate-silent    连续 2 次且处于 focus → fading
   *   rate-limit-hit 任何相位 → fading（强制降级 + 冷却）
   * 期满的懒过期在 phaseAt 读取时生效（focus/fading → cold）。
   */
  applyPhaseEvent(event: PhaseEvent, now: number, durations: PhaseDurations): void {
    // 先归一化过期相位
    if (this.phase !== 'cold' && now >= this.phaseUntil) {
      this.phase = 'cold';
      this.focusSpokeCount = 0;
      this.consecutiveGateSilent = 0;
    }
    switch (event) {
      case 'spoke': {
        this.consecutiveGateSilent = 0;
        this.spokeAt.push(now);
        const cutoff = now - 3_600_000;
        while (this.spokeAt.length > 0 && this.spokeAt[0]! < cutoff) this.spokeAt.shift();
        if (this.phase === 'cold') {
          this.phase = 'focus';
          this.phaseUntil = now + durations.focusMs;
          this.focusSpokeCount = 1;
        } else if (this.phase === 'focus') {
          this.focusSpokeCount += 1;
          if (this.focusSpokeCount >= durations.focusMaxReplies) {
            this.phase = 'fading';
            this.phaseUntil = now + durations.fadingMs;
          } else {
            this.phaseUntil = now + durations.focusMs;
          }
        } else {
          this.phaseUntil = now + durations.fadingMs;
        }
        return;
      }
      case 'gate-silent': {
        this.consecutiveGateSilent += 1;
        if (this.phase === 'focus' && this.consecutiveGateSilent >= 2) {
          this.phase = 'fading';
          this.phaseUntil = now + durations.fadingMs;
        }
        return;
      }
      case 'rate-limit-hit': {
        if (this.phase !== 'fading') {
          this.phase = 'fading';
          this.phaseUntil = now + durations.fadingMs;
        }
        return;
      }
    }
  }
}

/**
 * 从 bot 发言文本提取实词关键词（12 号规则的输入）：
 * 拉丁词整取（≥3 字母）；CJK 没有分词，长串（>4 字）取整串 + 全部 2/3 字
 * n-gram（宁可漏不可滥——误命中只是多一次 Gate 判定）。去停用词，上限 20 个。
 */
export function extractKeywords(text: string): string[] {
  const STOPWORDS = new Set([
    '这个', '那个', '什么', '可以', '没有', '就是', '已经', '一下', '如果', '因为',
    '所以', '但是', '而且', '我们', '你们', '他们', '自己', 'the', 'and', 'for',
    'with', 'that', 'this',
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (word: string): void => {
    if (word === '' || STOPWORDS.has(word) || seen.has(word)) return;
    if (out.length >= 20) return;
    seen.add(word);
    out.push(word);
  };
  for (const match of text.matchAll(/[一-鿿]+|[a-zA-Z]{3,}/g)) {
    const run = match[0];
    if (/^[a-zA-Z]+$/.test(run)) {
      push(run);
      continue;
    }
    if (run.length < 2) continue;
    if (run.length <= 4) {
      push(run);
      continue;
    }
    for (const n of [3, 2]) {
      for (let i = 0; i + n <= run.length; i += 1) {
        push(run.slice(i, i + n));
      }
    }
  }
  return out;
}
