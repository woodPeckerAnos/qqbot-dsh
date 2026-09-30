/**
 * 话题介入的 LLM 客户端：Gate 判定与规则生成口共用。
 *
 * 为什么直连 chat completions API 而不经 DSH 进程（方案 §6.2）：
 * 判定与生成都只需要「一次无工具的结构化输出」，起一个 runtime 进程是浪费，
 * 还会污染会话工作区。
 *
 * 纪律：
 *   - 一切失败 fail-closed：HTTP 错误 / 超时 / 非 JSON / 未知 decision
 *     一律映射为 silent（judge）或抛出让生成器进修复循环（complete）；
 *   - 密钥只从 env 来（DEEPSEEK_API_KEY 或生成器的 GEN_RULE_*），不进配置文件；
 *   - 离线单测通过注入 fetchImpl 覆盖，不触网。
 */

import type { GateClient, GateJudgeInput, GateVerdict } from './contract.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatClientOptions {
  /** OpenAI 兼容 API 基址（不含 /chat/completions 后缀） */
  apiBase: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 测试注入；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface ChatClient {
  /** 一次无工具的对话补全，返回 assistant 文本。失败抛错（调用方决定降级）。 */
  complete(messages: ChatMessage[]): Promise<string>;
}

export function createChatClient(options: ChatClientOptions): ChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(`${options.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`LLM API HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content === '') {
          throw new Error('LLM API 返回体缺少 choices[0].message.content');
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Gate 判定的输出契约（固定段，不在规则需求文档里）：
 * 严格 JSON、decision 三选一、reason 一句话。解析失败一律 silent。
 */
const GATE_OUTPUT_CONTRACT = [
  '你只能输出一个 JSON 对象，不要输出任何其他内容：',
  '{"decision":"spek|wait|silent","reason":"<20字内理由>"}'.replace('spek', 'speak'),
  'decision 只能是 speak / wait / silent 之一。',
].join('\n');

/** 从模型输出里提取判定 JSON（容忍 ```json 围栏与前后噪点），失败返回 undefined。 */
export function parseGateVerdict(raw: string): GateVerdict | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const decision = (parsed as Record<string, unknown>)['decision'];
  const reason = (parsed as Record<string, unknown>)['reason'];
  if (decision !== 'speak' && decision !== 'wait' && decision !== 'silent') return undefined;
  return {
    decision,
    reason: typeof reason === 'string' && reason !== '' ? reason : '(无理由)',
  };
}

/**
 * 构造语义 Gate 客户端（20-semantic-gate 规则的 ctx.gate 实现，Phase 2 接线）。
 * 判定标准正文来自规则 20 的 REQUIREMENT.md（需求即 prompt 来源，方案 §5.6），
 * 这里只拼输出契约；任何失败 fail-closed 为 silent。
 */
export function createGateClient(
  options: ChatClientOptions & { criteria: string },
): GateClient {
  const chat = createChatClient(options);
  return {
    async judge(input: GateJudgeInput): Promise<GateVerdict> {
      try {
        const raw = await chat.complete([
          {
            role: 'system',
            content: [
              '你是 QQ 群里一个任务型助手的发言守门人。',
              options.criteria,
              GATE_OUTPUT_CONTRACT,
            ].join('\n\n'),
          },
          {
            role: 'user',
            content: `${input.stateSummary}\n\n${input.transcript}`,
          },
        ]);
        return parseGateVerdict(raw) ?? { decision: 'silent', reason: 'gate-output-unparseable' };
      } catch {
        return { decision: 'silent', reason: 'gate-call-failed' };
      }
    },
  };
}
