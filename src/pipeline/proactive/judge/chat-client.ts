import { SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  ChatClientOptions,
  ChatClient,
  ChatMessage,
  JudgmentDiagnostics,
  JudgmentResult,
  TaskClock,
} from '@qqbot/contracts';

export type { ChatClientOptions, ChatClient } from '@qqbot/contracts';
type Attempt = { result: JudgmentResult<string>; retryAfter?: string | null };

/** One timeout and one caller-owned concurrency slot cover requests and backoff. */
export function createChatClient(options: ChatClientOptions): ChatClient {
  const completeResult = (messages: ChatMessage[]) => new ChatRequest(options).run(messages);
  return {
    completeResult,
    async complete(messages) {
      const result = await completeResult(messages);
      if (result.ok) return result.value;
      throw new Error(
        `LLM API ${result.failureClass}, HTTP ${result.diagnostics.httpStatus ?? 'unknown'}`
      );
    },
  };
}
class ChatRequest {
  private readonly clock: TaskClock;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private diagnostics: JudgmentDiagnostics;
  constructor(private readonly options: ChatClientOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.deadline = this.clock.now() + options.timeoutMs;
    this.diagnostics = { requestModel: options.model, attempts: 0, retryCount: 0 };
  }
  async run(messages: ChatMessage[]): Promise<JudgmentResult<string>> {
    let expire!: () => void;
    const expired = new Promise<JudgmentResult<string>>((resolve) => {
      expire = () => {
        this.controller.abort();
        resolve({ ok: false, failureClass: 'timeout', diagnostics: { ...this.diagnostics } });
      };
    });
    const timer = this.clock.setTimeout(expire, this.options.timeoutMs);
    try {
      return await Promise.race([this.request(messages), expired]);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }
  private async request(messages: ChatMessage[]): Promise<JudgmentResult<string>> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.controller.signal.aborted || this.clock.now() >= this.deadline)
        return { ok: false, failureClass: 'timeout', diagnostics: this.diagnostics };
      this.diagnostics = {
        requestModel: this.options.model,
        attempts: attempt,
        retryCount: attempt - 1,
      };
      const { result, retryAfter } = await this.attempt(messages);
      if (result.ok || !retryable(result) || attempt === 3) return result;
      await this.pause(this.backoff(attempt, retryAfter));
    }
    return { ok: false, failureClass: 'unknown', diagnostics: this.diagnostics };
  }
  private async attempt(messages: ChatMessage[]): Promise<Attempt> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.apiBase}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({ model: this.options.model, messages, temperature: 0 }),
          signal: this.controller.signal,
        }
      );
      this.diagnostics.httpStatus = response.status;
      if (!response.ok)
        return {
          result: { ok: false, failureClass: 'http', diagnostics: this.diagnostics },
          retryAfter: response.headers.get('Retry-After'),
        };
      const result = await readCompletion(response, this.diagnostics);
      this.diagnostics = result.diagnostics;
      return { result };
    } catch {
      return {
        result: {
          ok: false,
          failureClass: this.controller.signal.aborted ? 'timeout' : 'network',
          diagnostics: this.diagnostics,
        },
      };
    }
  }
  private backoff(attempt: number, header: string | null | undefined): number {
    const remaining = Math.max(0, this.deadline - this.clock.now());
    if (this.diagnostics.httpStatus === 429) {
      const suggested = retryAfterMs(header, this.clock.now());
      if (suggested !== undefined && suggested < remaining) return suggested;
    }
    const delay = attempt === 1 ? 250 : 1000;
    return Math.min(delay, remaining);
  }
  private pause(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.controller.signal;
      const finish = () => {
        this.clock.clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = this.clock.setTimeout(finish, delay);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
function retryable(result: Extract<JudgmentResult<string>, { ok: false }>): boolean {
  if (result.failureClass === 'network') return true;
  if (result.failureClass !== 'http') return false;
  const status = result.diagnostics.httpStatus ?? 0;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}
async function readCompletion(
  response: Response,
  diagnostics: JudgmentDiagnostics
): Promise<JudgmentResult<string>> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, failureClass: 'parse', diagnostics };
    throw error;
  }
  const data = record(raw);
  const choice = Array.isArray(data?.choices) ? record(data.choices[0]) : undefined;
  const message = record(choice?.message);
  const metadata = responseMetadata(data, choice, message);
  const content = message?.content;
  if (typeof content !== 'string' || content.trim() === '')
    return {
      ok: false,
      failureClass: 'response-contract',
      diagnostics: { ...diagnostics, ...metadata },
    };
  return { ok: true, value: content, diagnostics: { ...diagnostics, ...metadata } };
}
function responseMetadata(
  data?: Record<string, unknown>,
  choice?: Record<string, unknown>,
  message?: Record<string, unknown>
): JudgmentDiagnostics {
  return {
    responseModel: typeof data?.model === 'string' ? data.model : undefined,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    contentLength: textLength(message?.content),
    reasoningLength: textLength(message?.reasoning_content),
  };
}
function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
