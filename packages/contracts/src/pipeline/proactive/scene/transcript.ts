/**
 * 转录渲染：把旁听缓冲变成喂给判定的文本，并套上**不可信内容边界**。
 *
 * 边界标记不只是礼貌：转录是群友写的，里面完全可能有人写"忽略以上指令"。
 * 既有实现（`pipeline/topic-judge.ts`、转发块展开）都用同一套声明，
 * 这里保持一致——**任何用户产生的文本进 prompt 前都要包**。
 *
 * 另外两件事：
 *   - 显式标注**哪些是 bot 自己说的**（`[我]`）：否则模型分不清哪句是自己
 *     刚说过的，场景 1 的"接续自己上一条"就无从判断；
 *   - 给出结构化事实块（挂起问题、参与人数、bot 发言次数）：让模型不必从
 *     转录里数数——数数正是幻觉的高发区。
 */
/**
 * 转录渲染：把旁听缓冲变成喂给判定的文本，并套上**不可信内容边界**。
 *
 * 边界标记不只是礼貌：转录是群友写的，里面完全可能有人写"忽略以上指令"。
 * 既有实现（`pipeline/topic-judge.ts`、转发块展开）都用同一套声明，
 * 这里保持一致——**任何用户产生的文本进 prompt 前都要包**。
 *
 * 另外两件事：
 *   - 显式标注**哪些是 bot 自己说的**（`[我]`）：否则模型分不清哪句是自己
 *     刚说过的，场景 1 的"接续自己上一条"就无从判断；
 *   - 给出结构化事实块（挂起问题、参与人数、bot 发言次数）：让模型不必从
 *     转录里数数——数数正是幻觉的高发区。
 */
import type { SceneEvidence } from '../contract.js';
import type { ObservationEntry } from '../../../store/window.js';
/** 转录正文的字符上限（超出从头部截断，保留最近的）。 */
export const TRANSCRIPT_MAX_CHARS = 4_000;
export interface RenderTranscriptOptions {
  /** 最多渲染多少条（缺省 30） */
  limit?: number;
  maxChars?: number;
  /** bot 自己的显示名（用于标注"哪句是我说的"），缺省 `我` */
  botLabel?: string;
}
/**
 * 渲染近期聊天记录。
 *
 * 被 @ 的消息（`addressed`）**也在里面**：场景 1 要知道"bot 回答了谁、
 * 回答了什么"，把 addressed 消息排除掉会让判定看不到对话的另一半。
 */
export type renderTranscript = (
  entries: readonly ObservationEntry[],
  options?: RenderTranscriptOptions
) => string;
/**
 * 结构化事实块：把状态计数直接交给模型，省掉"从转录里数数"的幻觉来源。
 * 与 `judge.ts` 的 `renderFacts` 同源，这里是**进 user 消息**的那一份
 * （判据在 system 段，事实在 user 段）。
 */
export type renderFacts = (evidence: SceneEvidence, pendingQuestions?: readonly string[]) => string;
