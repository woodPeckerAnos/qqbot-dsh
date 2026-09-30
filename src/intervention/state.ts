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

import type { NormalizedObservedMessage } from '../core/connector.js';

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
  /** 旧 → 新；超出容量/年龄从头部淘汰 */
  readonly entries: ObservedEntry[] = [];
  readonly seen = new LruSet(500);
  runtimeEnabled: boolean | undefined = undefined;

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

  /** runner：把一条消息追加进缓冲（同时按容量与年龄淘汰）。 */
  pushEntry(message: NormalizedObservedMessage, now: number): void {
    this.seen.claim(message.eventId);
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
}
