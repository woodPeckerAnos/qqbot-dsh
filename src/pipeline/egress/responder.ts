/**
 * Egress 收口：一条用户消息的所有回复都经 Responder 发出。
 *
 * 为什么收口：
 *   QQ 的被动回复窗口把"回复次数"变成稀缺资源（群聊 5 分钟 / 5 次），
 *   所以 `ReplyLedger` 必须是**唯一**分配 `msg_seq` 的地方。收口前它散在
 *   runTurn / replySimple / deliverOutcome 三处各自 new，不变量靠注释维持；
 *   现在一条消息一个 Responder、一个账本，不变量由结构保证。
 *
 * 职责边界：
 *   - 持有配额账本（ReplyLedger）与进度回执调度（ProgressScheduler）；
 *   - 长文本分段（segmentText）、配额分配、经 BotConnector.reply 发送；
 *   - 把 turn 结果（TurnOutcome）渲染成用户可读文案（deliver）；
 *   - 记录助手回复到对话记录（供重启后回放）；
 *   - 平台专有行为（msg_seq、markdown 请求体）仍在适配器内，这里只调 reply()。
 *
 * 生命周期：每条用户消息一个实例，由 Ingress 管线入口创建，随消息处理结束而弃。
 * 同一条消息要么走"简短回复"路径（error），要么走"turn 结果"路径
 * （startProgress → deliver），不会两条都走。
 */

import type {
  BotConnector,
  NormalizedMessage,
  OutgoingAttachment,
  OutgoingMessage,
  ReplyPolicy,
} from '../../core/connector.js';
import type { TurnOutcome } from '../../dsh/turns.js';
import type { Logger } from '../../logger.js';
import type { ConversationStore } from '../../store/conversations.js';
import { segmentText } from './chunk.js';
import { archiveSent, scanOutbox } from './outbox.js';
import { packFiles } from './zip.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProgressScheduler,
  ReplyLedger,
  ReplyQuotaExhaustedError,
  type ReplyTicket,
} from './progress.js';
import type { PipelineStats } from '../stats.js';

/** 打包 zip 的临时子目录（隐藏目录，outbox 扫描器天然跳过）。 */
const PACKED_DIR_NAME = '.packed';

export interface ResponderOptions {  /** 触发本次回复的用户消息（target / msgId 都从这里取） */
  message: NormalizedMessage;
  connector: BotConnector;
  policy: ReplyPolicy;
  conversations: ConversationStore;
  stats: PipelineStats;
  logger: Logger;
  /** 富媒体出站（agent 产物回发）。缺省 = 不扫描 outbox，纯文本行为。 */
  media?: ResponderMediaOptions;
  now?: () => number;
}

/**
 * 富媒体出站配置（来自全局 media 配置 + 本会话的 outbox 绝对路径）。
 *
 * 为什么放在 ResponderOptions 而不是 ReplyPolicy：当前两个平台的出站限制
 * 一致（全局 media 配置），没有按平台分化的实际需求；ReplyPolicy 保持表达
 * "配额/窗口"这类平台硬约束。哪天官方与 OneBot 的限制真的分化了，再下沉。
 */
export interface ResponderMediaOptions {
  /** 本会话工作区内 outbox 目录的绝对路径（由装配层拼好） */
  outboxDir: string;
  /** 单附件体积上限（字节） */
  maxFileBytes: number;
  /** 单次回复最多发几个附件 */
  maxAttachments: number;
  /** 图片扩展名白名单（小写不带点），其余一律按文件发 */
  imageExtensions: readonly string[];
}

export class Responder {
  private readonly ledger: ReplyLedger;
  private progress: ProgressScheduler | undefined;
  /** 本条消息进入管线的时间：outbox 只发晚于它的文件（见 outbox.ts notBeforeMs） */
  private readonly createdAt: number;

  constructor(private readonly options: ResponderOptions) {
    const { message, policy } = options;
    this.ledger = new ReplyLedger({
      msgId: message.msgId,
      totalQuota: policy.maxRepliesPerMsg,
      progressQuota: policy.progressMax,
    });
    this.createdAt = this.now();
  }

  /**
   * 本条用户消息已经用掉的回复条数（= 已分配的 msg_seq 数）。
   *
   * 后台结果主动推送要接着这个号往后排（见 egress/background.ts），否则同
   * `(msg_id, msg_seq)` 会被官方平台去重（40054005），用户收不到。
   */
  get repliesSent(): number {
    return this.ledger.sent;
  }

  /**
   * 发一条简短回复（闸通知 / 命令回执 / 忙提示 / 错误）。
   * 配额不足时静默失败——这条语义从 replySimple 继承：提示类消息不该再抛错。
   */
  async error(text: string): Promise<void> {
    await this.sendLong(text, 'error');
  }

  /**
   * 起进度回执调度（TurnRunner 在 prompt 派发成功后调用）。
   *
   * @param renderText 进度文案生成器，入参是 turn 已用时长（毫秒），
   *   由调用方闭包携带 accumulator 状态（toolsInvoked 等）。
   */
  startProgress(renderText: (elapsedMs: number) => string): void {
    const { policy, logger, stats } = this.options;
    this.progress = new ProgressScheduler({
      afterMs: policy.progressAfterMs,
      intervalMs: policy.progressIntervalMs,
      renderText,
      send: async (text) => {
        const ticket = this.ledger.allocate('progress');
        await this.sendSegment({ text }, ticket);
        stats.progressSent += 1;
      },
      allocateTicket: () => {
        // 试分配哨兵：真正的分配发生在 send 里。这里只回答"还该不该继续调度"。
        if (this.ledger.progressRemaining <= 0 || this.ledger.remaining <= 1) return undefined;
        return { kind: 'progress', msgSeq: -1, remaining: this.ledger.remaining };
      },
      logger,
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    });
    this.progress.start();
  }

  /** 停进度回执调度（turn 结束时调用，幂等）。 */
  stopProgress(): void {
    this.progress?.stop();
  }

  /**
   * 把一轮 turn 的结果发给用户，并记录到对话记录。
   *
   * 结果一律按 'final' 记账：即使是 error 类结果，它也是对本轮提问的正式答复，
   * 不应占用 error 那条"系统级错误提示"的语义。
   *
   * 附件（outbox 产物）与文本共享同一个配额账本，分配规则（定稿见
   * docs/RICH-MEDIA-PLAN.md §5，改动前先读那段论证）：
   *   1. 平时**文本保底 1 条**：附件预算 = 剩余额度 - 1；
   *   2. 生死二选一（只剩 1 条额度且有附件）时**反转给附件**——超时场景下
   *      文本只是"中断了"的告知，可以并入后续回复；文件不发就丢了；
   *   3. 发送顺序**附件先、文本后**：先保证稀缺额度用在不可再生的内容上；
   *   4. 超预算/超体积的附件降级为文本里的一行说明，不静默丢弃。
   */
  async deliver(outcome: TurnOutcome): Promise<void> {
    const { message, conversations, logger, stats } = this.options;
    const conversationKey = message.target.key;

    // --- 扫描 outbox，按配额规则决定发哪几个附件 ---------------------------
    const media = this.options.media;
    let attachments: OutgoingMessage['attachments'] = [];
    const degradeNotes: string[] = [];
    let packedZipPath: string | undefined;
    let packOriginals: string[] = [];
    if (media !== undefined) {
      const scan = await scanOutbox(media.outboxDir, {
        maxFileBytes: media.maxFileBytes,
        imageExtensions: media.imageExtensions,
        notBeforeMs: this.createdAt,
        logger,
      });
      if (scan.oversize.length > 0) {
        degradeNotes.push(`（有 ${scan.oversize.length} 个文件超过大小上限，未发出：${scan.oversize.join('、')}）`);
      }
      if (scan.attachments.length > 0) {
        const remaining = this.ledger.remaining;
        // 规则 1 与 2：>=2 条额度时给文本留 1 条；只剩 1 条时全给附件
        const quotaBudget = remaining >= 2 ? remaining - 1 : remaining;
        const budget = Math.min(quotaBudget, media.maxAttachments, scan.attachments.length);
        let selected = scan.attachments.slice(0, budget);
        const overflow = scan.attachments.slice(budget);
        if (overflow.length > 0) {
          degradeNotes.push(
            `（回复条数有限，还有 ${overflow.length} 个文件未发出：${overflow
              .map((item) => item.fileName)
              .join('、')}；需要的话跟我说一声）`,
          );
        }
        // 多个文件合并成一个 zip 发一条消息（"发送文件本身仅允许单文件"的
        // 桥接侧兑现）：群聊里逐条发文件既刷屏又割裂阅读。
        if (selected.length > 1) {
          const packed = await this.packAsZip(media.outboxDir, selected, media.maxFileBytes, logger);
          if (packed.attachment !== undefined) {
            packedZipPath = packed.attachment.absPath;
            packOriginals = selected.map((item) => item.fileName);
            selected = [packed.attachment];
            degradeNotes.push(
              `（${packed.fileCount} 个产物已打包为 ${packed.attachment.fileName}）`,
            );
          } else {
            selected = [];
            if (packed.note !== undefined) degradeNotes.push(packed.note);
          }
        }
        attachments = selected;
      }
    }

    let text = outcome.text;
    switch (outcome.kind) {
      case 'completed':
        // 有附件时不用占位文案：文件本身就是答复
        if (text === '' && (attachments === undefined || attachments.length === 0)) {
          text = '（这次没有产生可回复的内容）';
        }
        break;
      case 'max-tokens':
        text = `${text}\n\n（回答达到长度上限被截断，可以让我继续）`.trim();
        break;
      case 'timeout':
        text =
          text === ''
            ? '这个任务超过了单轮时限，我已经把它中断了。可以拆成更小的步骤再让我试。'
            : `任务超过单轮时限已中断。中断前已完成的部分：\n\n${text}`;
        break;
      case 'aborted':
        text = text === '' ? '任务被中断了。' : `任务被中断。中断前的部分结果：\n\n${text}`;
        break;
      case 'blocked':
        text = '这个操作被安全策略阻止了，我无法执行。';
        break;
      case 'error':
      default:
        text =
          text === ''
            ? `执行出错了${outcome.errorMessage !== undefined ? `：${outcome.errorMessage}` : ''}`
            : `${text}\n\n（执行过程中出现错误${
                outcome.errorMessage !== undefined ? `：${outcome.errorMessage}` : ''
              }）`;
        break;
    }
    if (degradeNotes.length > 0) {
      text = text === '' ? degradeNotes.join('\n') : `${text}\n${degradeNotes.join('\n')}`;
    }

    // --- 附件先、文本后 ------------------------------------------------------
    let sentAttachments = 0;
    const sentDisplayNames: string[] = [];
    const archiveNames: string[] = [];
    for (const attachment of attachments ?? []) {
      let ticket: ReplyTicket;
      try {
        ticket = this.ledger.allocate('final');
      } catch (error) {
        if (error instanceof ReplyQuotaExhaustedError) {
          logger.warn('回复配额用尽，剩余附件未发送', { used: error.used, total: error.total });
          break;
        }
        throw error;
      }
      try {
        await this.sendSegment({ text: '', attachments: [attachment] }, ticket);
        sentAttachments += 1;
        sentDisplayNames.push(attachment.fileName);
        // zip 包发送成功 = 包内原始文件全部送达，归档的是原件而不是包
        if (packedZipPath !== undefined && attachment.absPath === packedZipPath) {
          archiveNames.push(...packOriginals);
        } else {
          archiveNames.push(attachment.fileName);
        }
        stats.attachmentsSent += 1;
      } catch (error) {
        logger.error('发送附件失败', {
          seq: ticket.msgSeq,
          fileName: attachment.fileName,
          error: error instanceof Error ? error.message : String(error),
        });
        // 一个附件失败不阻塞其余：继续尝试（失败的文件留在 outbox，不归档）
      }
    }
    // zip 是派生产物，用完即删（发送失败时原件仍在 outbox，可重新打包）
    if (packedZipPath !== undefined) {
      await rm(packedZipPath, { force: true }).catch(() => {});
    }
    if (media !== undefined && archiveNames.length > 0) {
      await archiveSent(media.outboxDir, archiveNames, logger, () => this.now());
    }

    const sentAnyText = await this.sendLong(text, 'final');
    if (!sentAnyText && sentAttachments === 0) {
      logger.warn('本轮结果未能发送出去（配额或平台错误）', { kind: outcome.kind });
    }

    // 记录助手回复（供下次冷启动回放）：附件也在记录里留名，
    // 否则冷启动后的 agent 不知道文件已经发出去了
    const recordText =
      sentDisplayNames.length > 0
        ? `${text}${text === '' ? '' : '\n'}（已发送文件：${sentDisplayNames.join('、')}）`
        : text;
    conversations.append(conversationKey, {
      role: 'assistant',
      speaker: 'bot',
      text: recordText,
      ts: this.now(),
      replyToMsgId: message.msgId,
    });
  }

  /**
   * 把长文本按配额分段发送。
   * @returns 是否至少成功发出一条
   */
  private async sendLong(text: string, kind: 'final' | 'error'): Promise<boolean> {
    const { policy, logger } = this.options;
    // 剩余配额决定最多能分几段
    const maxSegments = Math.min(this.ledger.remaining, policy.maxRepliesPerMsg);

    const result = segmentText(text, { maxChars: policy.maxChars, maxSegments });
    if (result.truncated) {
      logger.warn('内容超出回复配额，已截断', {
        originalLength: result.originalLength,
        segments: result.segments.length,
      });
    }

    let sent = 0;
    for (const segment of result.segments) {
      let ticket: ReplyTicket;
      try {
        ticket = this.ledger.allocate(kind === 'error' ? 'error' : 'final');
      } catch (error) {
        if (error instanceof ReplyQuotaExhaustedError) {
          logger.warn('回复配额用尽，剩余内容未发送', { used: error.used, total: error.total });
          break;
        }
        throw error;
      }
      try {
        await this.sendSegment({ text: segment }, ticket);
        sent += 1;
      } catch (error) {
        logger.error('发送回复失败', {
          seq: ticket.msgSeq,
          error: error instanceof Error ? error.message : String(error),
        });
        // 一条失败不阻塞后续分段：继续尝试，尽可能把内容送达
      }
    }
    return sent > 0;
  }

  /** 实际发送一条消息：平台专有的渲染与端点选择都在连接器内部。 */
  private async sendSegment(out: OutgoingMessage, ticket: ReplyTicket): Promise<void> {
    const { message, connector, logger, stats } = this.options;
    await connector.reply(
      {
        target: message.target,
        seq: ticket.msgSeq,
        kind: ticket.kind,
        ...(message.msgId !== '' ? { msgId: message.msgId } : {}),
      },
      out,
    );
    stats.repliesSent += 1;
    logger.debug('已发送回复', {
      seq: ticket.msgSeq,
      kind: ticket.kind,
      length: out.text.length,
      attachments: out.attachments?.length ?? 0,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * 把多个产物打包成一个 zip（存放在 outbox/.packed/ 下，扫描器跳过隐藏目录）。
   *
   * 体积预算：stored zip ≈ 原始总字节 + 每条目 ~160B 元数据，先预估再实打包，
   * 超 maxFileBytes 直接降级为一行说明（不逐个降级发送——那又回到了刷屏）。
   */
  private async packAsZip(
    outboxDir: string,
    files: OutgoingAttachment[],
    maxFileBytes: number,
    logger: Logger,
  ): Promise<{ attachment?: OutgoingAttachment; fileCount: number; note?: string }> {
    const estimated = files.reduce((acc, file) => acc + file.sizeBytes, 0) + files.length * 160 + 22;
    if (estimated > maxFileBytes) {
      return {
        fileCount: files.length,
        note: `（${files.length} 个文件打包后仍超过大小上限，未发出：${files
          .map((file) => file.fileName)
          .join('、')}；可以让我分开几次发）`,
      };
    }
    try {
      const data = await packFiles(files);
      if (data.byteLength > maxFileBytes) {
        return {
          fileCount: files.length,
          note: `（${files.length} 个文件打包后超过大小上限，未发出；可以让我分开几次发）`,
        };
      }
      const packedDir = join(outboxDir, PACKED_DIR_NAME);
      await mkdir(packedDir, { recursive: true });
      const fileName = `产物打包-${this.now()}.zip`;
      const absPath = join(packedDir, fileName);
      await writeFile(absPath, data);
      return {
        attachment: { kind: 'file', absPath, fileName, sizeBytes: data.byteLength },
        fileCount: files.length,
      };
    } catch (error) {
      logger.warn('打包产物失败，本轮不发送附件', {
        files: files.map((file) => file.fileName),
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        fileCount: files.length,
        note: `（${files.length} 个文件打包失败，未发出：${files
          .map((file) => file.fileName)
          .join('、')}）`,
      };
    }
  }
}
