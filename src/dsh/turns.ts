/**
 * 把 DSH 的事件流归并成"一轮问答的结果"。
 *
 * 为什么需要这一层：`session/prompt` 只返回入队回执，真正结果靠 `session.event`
 * 推流。而一轮（turn）里模型会被调用**多次**（每步一次），所以
 * `assistant/message` 会有多条，中间那些通常只有工具调用没有文本。规则必须精确，
 * 否则会出现"回复了中间那句'我来看看'而不是最终答案"这类 bug。
 *
 * 归并规则（依据 docs/DESIGN.md 5.2）：
 *   1. 本轮 = 从 session.status 变 running 后开始；
 *   2. 累积所有 assistant/message 的文本块；
 *   3. 记下 turn/end 的 reason；
 *   4. status 回到 idle 且本轮已有 turn/end → 本轮结束；
 *   5. 最终答案 = 最后一条**非空** assistant/message 文本；没有则用累积文本。
 *
 * 对事件结构保持防御性：DSH 的 message.content 是 ContentBlock 数组，
 * 我们只取 type === 'text' 的块，其余（tool-call 等）忽略；结构不认识时
 * 不抛异常，只当作"没有文本"。
 */

import type { SessionEventEnvelope } from './protocol.js';

export type TurnOutcome =
  | { kind: 'completed'; text: string; reason: string }
  | { kind: 'error'; text: string; reason: string; errorMessage?: string }
  | { kind: 'max-tokens'; text: string; reason: string }
  | { kind: 'aborted'; text: string; reason: string }
  | { kind: 'blocked'; text: string; reason: string }
  | { kind: 'timeout'; text: string; reason: string };

/** 从 SessionEventMap['assistant/message'] 中抽出可见文本。 */
export function extractAssistantText(event: SessionEventEnvelope): string {
  if (event.type !== 'assistant/message') return '';
  const data = event.data as { message?: { content?: unknown } };
  const content = data.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text']);
    }
  }
  return parts.join('');
}

interface TurnEndData {
  turn?: number;
  reason?: {
    kind?: string;
    error?: { message?: string; code?: string };
  };
}

/** 把 turn/end 的 reason 映射成我们的结果分类。 */
function classifyReason(kind: string | undefined): TurnOutcome['kind'] {
  switch (kind) {
    case 'completed':
      return 'completed';
    case 'max-tokens':
      return 'max-tokens';
    case 'aborted':
      return 'aborted';
    case 'blocked':
      return 'blocked';
    case 'error':
    default:
      return 'error';
  }
}

/**
 * 一次 turn 的累积状态机。
 *
 * 用法：对每个 `session.event` 调用 `observe()`；对每个 `session.status` 调用
 * `observeStatus()`；当 `isSettled` 为真时取 `result()`。
 */
export class TurnAccumulator {
  private assistantTexts: string[] = [];
  private accumulated = '';
  private turnEnd: TurnEndData | undefined;
  private sawRunning = false;
  private sawIdle = false;
  private toolCallCount = 0;
  private readonly foreign: SessionEventEnvelope[] = [];

  constructor(readonly sessionId: string) {}

  get stepCount(): number {
    return this.assistantTexts.length;
  }

  get toolsInvoked(): number {
    return this.toolCallCount;
  }

  /** 与本轮无关的事件（用于诊断，例如 approval/asked） */
  get otherEvents(): readonly SessionEventEnvelope[] {
    return this.foreign;
  }

  observeStatus(status: 'idle' | 'running'): void {
    if (status === 'running') this.sawRunning = true;
    else this.sawIdle = true;
  }

  observe(event: SessionEventEnvelope): void {
    switch (event.type) {
      case 'assistant/message': {
        const text = extractAssistantText(event);
        this.assistantTexts.push(text);
        if (text.trim() !== '') this.accumulated = text;
        return;
      }
      case 'tool/call': {
        this.toolCallCount += 1;
        return;
      }
      case 'turn/end': {
        this.turnEnd = event.data as TurnEndData;
        return;
      }
      default:
        this.foreign.push(event);
    }
  }

  /**
   * 本轮是否已结束。
   *
   * 必须同时满足：见到过 turn/end，且 agent 回到 idle。
   * 只看 turn/end 会漏掉"turn 结束后还有后续事件"的情况；
   * 只看 idle 会在 turn 还没结束时（例如工具执行中的短暂 idle 抖动）误判。
   */
  get isSettled(): boolean {
    return this.turnEnd !== undefined && this.sawIdle;
  }

  get sawTurnEnd(): boolean {
    return this.turnEnd !== undefined;
  }

  /**
   * 最终答案：最后一条**非空**的 assistant 文本。
   *
   * 为什么不是"累积全部"：中间那些空的 assistant 消息对应只有工具调用的步骤，
   * 拼接它们没有意义；而多条非空文本里，最后一条才包含对用户的最终答复。
   */
  get finalText(): string {
    for (let i = this.assistantTexts.length - 1; i >= 0; i -= 1) {
      const text = this.assistantTexts[i];
      if (text !== undefined && text.trim() !== '') return text.trim();
    }
    return this.accumulated.trim();
  }

  /** 已产出的部分结果（超时/中断时用来给用户一个交代） */
  get partialText(): string {
    return this.accumulated.trim();
  }

  result(): TurnOutcome {
    const kind = classifyReason(this.turnEnd?.reason?.kind);
    const text = this.finalText;
    const reason = this.turnEnd?.reason?.kind ?? 'no-turn-end';
    if (kind === 'error') {
      const errorMessage = this.turnEnd?.reason?.error?.message;
      return {
        kind: 'error',
        text,
        reason,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      };
    }
    return { kind, text, reason };
  }

  /** 超时/外部取消时的结果 */
  timeoutResult(): TurnOutcome {
    return {
      kind: 'timeout',
      text: this.partialText,
      reason: 'turn-timeout',
    };
  }
}
