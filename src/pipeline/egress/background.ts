/**
 * 后台任务结果的主动投递器（BackgroundPusher）。
 *
 * 背景：后台子代理完成后，父代理跑一个"自发轮次"总结结果（TurnRunner 捕获）。
 * 但 QQ 官方被动回复窗口只有 5 分钟（单聊 60 分钟），窗口外无法主动补发；
 * OneBot 则完全没有窗口，任何时候都能主动发。本模块统一收口"捕获到后台结果后
 * 怎么送到用户手上"：
 *
 *   1. **能即时推送就推送**（OneBot 恒可行；官方在被动窗口内且回复配额未尽时可行），
 *      用该会话**最后一条用户消息**的 msg_id 作锚点、接着已用的 msg_seq 往后发；
 *   2. **推不出去就暂存**（pendingBackground），等该会话下一条用户消息的回复前置带出
 *      （由 TurnRunner.attachPendingBackground 取走）；
 *   3. 暂存**持久化**到 stateDir，桥接进程重启后仍能带出（内存态会在重启时丢）。
 *
 * 为什么锚点不持久化：msg_id 只在被动窗口内有效（几分钟），重启后基本都过期了，
 * 持久化没有意义；重启后 OneBot/官方都退回"下一条消息带出"，安全且不丢内容。
 *
 * seq 续号是官方平台的硬约束：同 `(msg_id, msg_seq)` 重复发送会被去重（40054005），
 * 用户收不到。所以主动推送必须从"原轮次已用条数 + 1"开始，见 ReplyAnchor.usedSeq。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BotConnector, ConversationTarget, ReplyPolicy } from '../../core/connector.js';
import type { Logger } from '../../logger.js';
import type { ConversationStore } from '../../store/conversations.js';
import type { PipelineStats } from '../stats.js';
import { segmentText } from './chunk.js';

/** 一次主动推送的锚点：某会话最后一条用户消息的寻址与已用回复序号。 */
export interface ReplyAnchor {
  target: ConversationTarget;
  /** 被动回复锚点（官方用；OneBot 忽略）。空串表示无锚点。 */
  msgId: string;
  /** 该用户消息的到达时间（毫秒），用于判断是否仍在被动窗口内 */
  msgTs: number;
  /** 针对该 msgId 已用掉的回复条数；下一条可用 seq = usedSeq + 1 */
  usedSeq: number;
}

export interface BackgroundPusherDeps {
  connectors: ReadonlyMap<string, BotConnector>;
  conversations: ConversationStore;
  stats: PipelineStats;
  logger: Logger;
  /** 暂存持久化文件路径；缺省 = 纯内存不落盘（测试或无状态部署） */
  persistPath?: string;
  /** 单会话最多暂存几条待带出的结果（超出丢最旧），防长时间无消息时无限累积 */
  maxPendingPerConversation?: number;
  now?: () => number;
}

/** health/metrics 暴露的后台状态快照。 */
export interface BackgroundSnapshot {
  /** 有待带出结果的会话数 */
  pendingConversations: number;
  /** 待带出结果总条数 */
  pendingTotal: number;
}

interface PersistShape {
  version: 1;
  pending: Record<string, string[]>;
}

const DEFAULT_MAX_PENDING = 3;

export class BackgroundPusher {
  private readonly anchors = new Map<string, ReplyAnchor>();
  private readonly pending = new Map<string, string[]>();
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(private readonly deps: BackgroundPusherDeps) {
    this.maxPending = deps.maxPendingPerConversation ?? DEFAULT_MAX_PENDING;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  /**
   * 记录某会话最后一条用户消息的锚点（TurnRunner 在一轮 deliver 之后调用）。
   * 只保留最新一条：主动推送总是针对"最近一次还能被动回复的消息"。
   */
  noteAnchor(anchor: ReplyAnchor): void {
    this.anchors.set(anchor.target.key, { ...anchor });
  }

  /** 该会话当前是否有锚点（诊断/测试用）。 */
  hasAnchor(conversationKey: string): boolean {
    return this.anchors.has(conversationKey);
  }

  /**
   * 捕获到一条后台结果：能即时推送就推送，否则暂存待下次带出。
   *
   * 同步返回（内部对"是否可推送"做同步判定）；实际发送是异步的尽力而为，
   * 发送失败会回落到暂存，保证结果不丢。
   */
  capture(conversationKey: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;

    const plan = this.planPush(conversationKey, trimmed);
    if (plan === undefined) {
      this.stash(conversationKey, trimmed);
      return;
    }
    // 乐观地认为会推送成功；发送失败在 catch 里回落暂存。
    void plan
      .send()
      .then((sent) => {
        if (!sent) this.stash(conversationKey, trimmed);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('后台结果主动推送失败，转为暂存', {
          conversation: conversationKey,
          error: error instanceof Error ? error.message : String(error),
        });
        this.stash(conversationKey, trimmed);
      });
  }

  /** 取走并清空某会话暂存的后台结果（TurnRunner 在下一条回复里前置带出）。 */
  takePending(conversationKey: string): string[] {
    const queue = this.pending.get(conversationKey);
    if (queue === undefined || queue.length === 0) return [];
    this.pending.delete(conversationKey);
    this.persist();
    return queue;
  }

  /** health/metrics 用的后台状态快照。 */
  snapshot(): BackgroundSnapshot {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return { pendingConversations: this.pending.size, pendingTotal: total };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 规划一次主动推送：判定平台是否允许此刻主动发，允许则返回一个发送闭包。
   * 判定是同步的（窗口/配额都基于当前 anchor 与 policy），发送是异步的。
   */
  private planPush(
    conversationKey: string,
    text: string,
  ): { send: () => Promise<boolean> } | undefined {
    const anchor = this.anchors.get(conversationKey);
    if (anchor === undefined) return undefined;
    const connector = this.deps.connectors.get(anchor.target.platform);
    if (connector === undefined) return undefined;

    const policy: ReplyPolicy = connector.policy(anchor.target.kind);
    const now = this.now();
    // 窗口判定：OneBot 的 passiveWindowMs = +∞，恒在窗口内。
    if (now - anchor.msgTs >= policy.passiveWindowMs) return undefined;
    // 配额判定：下一条 seq 不能超过该消息的回复上限（官方硬约束；OneBot 是安全阀）。
    const remaining = policy.maxRepliesPerMsg - anchor.usedSeq;
    if (remaining <= 0) return undefined;

    return {
      send: () => this.sendActive(conversationKey, connector, anchor, policy, text, remaining),
    };
  }

  /** 真正发送：分段 → 逐段 reply（seq 从 usedSeq+1 续号）→ 记录对话。 */
  private async sendActive(
    conversationKey: string,
    connector: BotConnector,
    anchor: ReplyAnchor,
    policy: ReplyPolicy,
    text: string,
    remaining: number,
  ): Promise<boolean> {
    const result = segmentText(text, { maxChars: policy.maxChars, maxSegments: remaining });
    let seq = anchor.usedSeq;
    let sent = 0;
    for (const segment of result.segments) {
      seq += 1;
      try {
        await connector.reply(
          {
            target: anchor.target,
            seq,
            kind: 'final',
            ...(anchor.msgId !== '' ? { msgId: anchor.msgId } : {}),
          },
          { text: segment },
        );
        sent += 1;
        this.deps.stats.repliesSent += 1;
      } catch (error) {
        // 发送失败：停止后续分段，但仍推进 usedSeq（该 seq 可能已被平台受理，
        // 复用会触发去重）。已发出的部分算成功，剩余的由调用方回落暂存。
        this.deps.logger.warn('后台结果分段发送失败', {
          conversation: conversationKey,
          seq,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    // 推进锚点已用序号（无论成功与否，避免下次复用同一 seq）
    anchor.usedSeq = seq;
    if (result.truncated) {
      this.deps.logger.warn('后台结果超出剩余回复配额，已截断', {
        conversation: conversationKey,
        originalLength: result.originalLength,
      });
    }
    if (sent === 0) return false;

    this.deps.stats.backgroundPushed += 1;
    // 记录进对话（供冷启动回放）：主动推送的内容是独立一条 assistant 消息。
    this.deps.conversations.append(conversationKey, {
      role: 'assistant',
      speaker: 'bot',
      text,
      ts: this.now(),
      ...(anchor.msgId !== '' ? { replyToMsgId: anchor.msgId } : {}),
    });
    this.deps.logger.info('后台结果已主动推送', {
      conversation: conversationKey,
      segments: sent,
      platform: anchor.target.platform,
    });
    return true;
  }

  /** 暂存一条待带出的结果（推不出去时的回落），并持久化。 */
  private stash(conversationKey: string, text: string): void {
    const queue = this.pending.get(conversationKey) ?? [];
    queue.push(text);
    while (queue.length > this.maxPending) queue.shift();
    this.pending.set(conversationKey, queue);
    this.persist();
    this.deps.logger.debug('后台结果转为暂存，待下一条回复带出', {
      conversation: conversationKey,
      queued: queue.length,
    });
  }

  private persist(): void {
    const file = this.deps.persistPath;
    if (file === undefined) return;
    const payload: PersistShape = {
      version: 1,
      pending: Object.fromEntries([...this.pending.entries()]),
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      // 持久化失败不致命：最坏情况是重启后丢失暂存（本就尽力而为）
      this.deps.logger.warn('写入后台结果暂存失败（不影响运行）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private load(): void {
    const file = this.deps.persistPath;
    if (file === undefined || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistShape>;
      if (parsed.version !== 1 || parsed.pending === undefined) {
        this.deps.logger.warn('后台结果暂存文件版本不认识，忽略', { version: parsed.version });
        return;
      }
      for (const [key, queue] of Object.entries(parsed.pending)) {
        if (!Array.isArray(queue)) continue;
        const cleaned = queue.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
        if (cleaned.length > 0) this.pending.set(key, cleaned.slice(-this.maxPending));
      }
      if (this.pending.size > 0) {
        this.deps.logger.info('已加载后台结果暂存', { conversations: this.pending.size });
      }
    } catch (error) {
      this.deps.logger.warn('后台结果暂存解析失败，忽略', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
