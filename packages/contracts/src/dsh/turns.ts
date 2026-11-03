/**
 * 把 DSH 的事件流归并成"一轮问答的结果"。
 *
 * 为什么需要这一层：`session/prompt` 只返回入队回执，真正结果靠 `session.event`
 * 推流。而一轮（turn）里模型会被调用**多次**（每步一次），所以
 * `assistant/message` 会有多条，中间那些通常只有工具调用没有文本。规则必须精确，
 * 否则会出现"回复了中间那句'我来看看'而不是最终答案"这类 bug。
 *
 * 归并规则：
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
/**
 * 把 DSH 的事件流归并成"一轮问答的结果"。
 *
 * 为什么需要这一层：`session/prompt` 只返回入队回执，真正结果靠 `session.event`
 * 推流。而一轮（turn）里模型会被调用**多次**（每步一次），所以
 * `assistant/message` 会有多条，中间那些通常只有工具调用没有文本。规则必须精确，
 * 否则会出现"回复了中间那句'我来看看'而不是最终答案"这类 bug。
 *
 * 归并规则：
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
  | {
      kind: 'completed';
      text: string;
      reason: string;
    }
  | {
      kind: 'error';
      text: string;
      reason: string;
      errorMessage?: string;
    }
  | {
      kind: 'max-tokens';
      text: string;
      reason: string;
    }
  | {
      kind: 'aborted';
      text: string;
      reason: string;
    }
  | {
      kind: 'blocked';
      text: string;
      reason: string;
    }
  | {
      kind: 'timeout';
      text: string;
      reason: string;
    };
/** 从 SessionEventMap['assistant/message'] 中抽出可见文本。 */
export type extractAssistantText = (event: SessionEventEnvelope) => string;
export interface TurnAccumulator {
  readonly sessionId: string;
  get stepCount(): number;
  get toolsInvoked(): number;
  /** 与本轮无关的事件（用于诊断，例如 approval/asked） */
  get otherEvents(): readonly SessionEventEnvelope[];
  observeStatus(status: 'idle' | 'running'): void;
  observe(event: SessionEventEnvelope): void;
  /**
   * 本轮是否已结束。
   *
   * 必须同时满足：见到过 turn/end，且 agent 回到 idle。
   * 只看 turn/end 会漏掉"turn 结束后还有后续事件"的情况；
   * 只看 idle 会在 turn 还没结束时（例如工具执行中的短暂 idle 抖动）误判。
   */
  get isSettled(): boolean;
  get sawTurnEnd(): boolean;
  /**
   * 最终答案：最后一条**非空**的 assistant 文本。
   *
   * 为什么不是"累积全部"：中间那些空的 assistant 消息对应只有工具调用的步骤，
   * 拼接它们没有意义；而多条非空文本里，最后一条才包含对用户的最终答复。
   */
  get finalText(): string;
  /** 已产出的部分结果（超时/中断时用来给用户一个交代） */
  get partialText(): string;
  result(): TurnOutcome;
  /** 超时/外部取消时的结果 */
  timeoutResult(): TurnOutcome;
  /**
   * 外部强制中断（/stop 命令）：runtime 进程随即被回收，真实事件流不会再推进
   * 本累积器，所以直接把状态补全为"已结束"，结果按 aborted 计。
   * 若本轮已经自然结束（turn/end 已到达），不改写真实结果。
   */
  forceAbort(): void;
}
export type createTurnAccumulatorFactory = (sessionId: string) => TurnAccumulator;
