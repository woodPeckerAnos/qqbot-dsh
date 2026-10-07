/**
 * 判定用的最小 Chat 客户端（OpenAI 兼容 `/chat/completions`）。
 *
 * 为什么又写一个（`pipeline/topic-judge.ts` 里已有一个内联版）：
 * 那个是"话题相关性"专用（输入/输出都是固定形状），本模块需要的是
 * **可注入、可并发限流、可换 prompt** 的通用一次补全。两者的失败语义也不同
 * （话题判定 fail-safe=相关，主动判定 fail-closed=沉默）。
 * 等第三处出现同样需求时再抽公共件——现在抽反而会把两套语义耦合起来。
 *
 * 契约：
 *   - 成功 → 返回 assistant 文本；
 *   - 失败（HTTP / 超时 / 响应体缺字段）→ **抛错**，由调用方决定降级
 *     （`judge/client.ts` 统一转成 undefined = 沉默）；
 *   - 密钥只从 env 来（组装层负责），不进配置文件、不进日志（logger 会脱敏）。
 */

import type { ChatMessage } from './client.js';

export interface ChatClientOptions {
  /** 基址，不含 `/chat/completions` 后缀 */
  apiBase: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 测试注入；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface ChatClient {
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
          body: JSON.stringify({ model: options.model, messages, temperature: 0 }),
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
