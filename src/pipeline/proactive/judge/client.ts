import type {
  ChatMessage,
  ProactiveJudgeInput,
  ProactiveJudge,
  CreateProactiveJudgeOptions,
  JudgmentResult,
} from '@qqbot/contracts';
/**
 * ② LLM 层的**调用侧**：把候选场景 + 转录 + 结构化事实发给模型，拿回逐场景判定。
 *
 * 与 `judge.ts` 的分工：
 *   - `judge.ts` 是**纯逻辑**：判据文案、prompt 渲染、输出解析（可离线单测）；
 *   - 本文件是**副作用侧**：真的发 HTTP、真的超时、真的降级（测试注入 fetchImpl）。
 *
 * 三条纪律（与既有 topic-judge / gate-client 同构）：
 *   1. **fail-closed**：超时 / HTTP 错误 / 解析失败一律返回 `undefined`，
 *      调用方据此保持沉默（主动发言的成本不对称：漏一次没事，误报一次招人烦）；
 *   2. **密钥只从 env 来**，不进配置文件；
 *   3. **全局并发闸**：判定是 LLM 调用，全局同时最多 N 个（默认 2），
 *      超出排队——否则长群里会出现"判定风暴"把配额吃光。
 */
import type { SceneVerdict } from '@qqbot/contracts';
import { JUDGE_OUTPUT_CONTRACT, parseSceneVerdicts, renderJudgeCriteria } from './judge.js';

/** 一次对话补全的消息（与 OpenAI 兼容 API 的形状一致）。 */
export type { ChatMessage } from '@qqbot/contracts';

/** 一次判定的输入：候选 + 事实 + 转录（转录已由调用方用不可信边界包裹）。 */
export type { ProactiveJudgeInput } from '@qqbot/contracts';

/** 判定能力（真实实现走 HTTP；测试注入 fake）。 */
export type { ProactiveJudge } from '@qqbot/contracts';

export type { ChatClientLike } from '@qqbot/contracts';

export type { CreateProactiveJudgeOptions } from '@qqbot/contracts';

/**
 * 组装判定客户端。
 *
 * prompt 结构（三段，与既有 judge 习惯一致）：
 *   system = 角色 + 判据清单 + 输出契约
 *   user   = 结构化事实 + 群聊转录
 * 顺序固定，便于用回放数据做 A/B 对比。
 */
export function createProactiveJudge(options: CreateProactiveJudgeOptions): ProactiveJudge {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else inFlight -= 1;
  };
  const acquire = async (): Promise<() => void> => {
    if (inFlight < maxConcurrent) inFlight += 1;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    return release;
  };
  const judgeResult = async (
    input: ProactiveJudgeInput
  ): Promise<JudgmentResult<readonly SceneVerdict[]>> => {
    const relinquish = await acquire();
    let result: JudgmentResult<readonly SceneVerdict[]>;
    try {
      result = await requestVerdicts(options, input);
    } catch {
      result = { ok: false, failureClass: 'unknown', diagnostics: {} };
    } finally {
      relinquish();
    }
    if (!result.ok)
      options.onError?.(
        result.failureClass === 'parse' ? 'unparseable' : 'call-failed',
        JSON.stringify({ failureClass: result.failureClass, ...result.diagnostics })
      );
    return result;
  };
  return {
    judgeResult,
    async judge(input) {
      const result = await judgeResult(input);
      return result.ok ? result.value : undefined;
    },
  };
}

async function requestVerdicts(
  options: CreateProactiveJudgeOptions,
  input: ProactiveJudgeInput
): Promise<JudgmentResult<readonly SceneVerdict[]>> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${options.renderCriteria(input.candidates)}\n\n${JUDGE_OUTPUT_CONTRACT}`,
    },
    { role: 'user', content: input.transcript },
  ];
  const completion = options.chat.completeResult
    ? await options.chat.completeResult(messages)
    : { ok: true as const, value: await options.chat.complete(messages), diagnostics: {} };
  if (!completion.ok) return completion;
  const verdicts = parseSceneVerdicts(completion.value, input.candidates);
  return verdicts === undefined
    ? { ok: false, failureClass: 'parse', diagnostics: completion.diagnostics }
    : { ok: true, value: verdicts, diagnostics: completion.diagnostics };
}

/** 便捷构造：直接用 `renderJudgeCriteria` 作为判据渲染。 */
export function createDefaultProactiveJudge(
  options: Omit<CreateProactiveJudgeOptions, 'renderCriteria'>
): ProactiveJudge {
  return createProactiveJudge({ ...options, renderCriteria: renderJudgeCriteria });
}
