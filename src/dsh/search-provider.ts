import { failure, SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  createSearchProviderFactory,
  ContractFailure,
  SearchFailureCause,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchSource,
  Result,
  TaskClock,
} from '@qqbot/contracts';

type ProviderOptions = Parameters<createSearchProviderFactory>[0];
type ApiError = { message: string; code?: string };
type DecodedSearch = { result: SearchResult } | { failure: SearchFailureCause };

/** HTTP response classification is completed before task policy receives a result. */
export class SearchHttpProvider implements SearchProvider {
  constructor(private readonly options: ProviderOptions) {}
  async search(request: SearchRequest, signal: AbortSignal): Promise<Result<SearchResult>> {
    if (!validSearchRequest(request)) return { ok: false, error: failure('INVALID_INPUT') };
    if (signal.aborted) return { ok: false, error: failure('CANCELLED') };
    if (!this.options.apiKey)
      return {
        ok: false,
        error: this.searchFailure({
          kind: 'service-error',
          provider: this.options.config.baseURL,
          message: '搜索服务缺少凭证。',
        }),
      };
    const deadline = searchDeadline(
      this.options.clock ?? SYSTEM_CLOCK,
      this.options.config.timeoutMs,
      signal
    );
    try {
      return await this.sendSearchRequest(request, this.options.apiKey, deadline.signal);
    } catch (cause) {
      if (deadline.signal.aborted && !deadline.expired)
        return { ok: false, error: failure('CANCELLED') };
      return {
        ok: false,
        error: this.searchFailure(
          {
            kind: 'service-error',
            provider: this.options.config.baseURL,
            message: deadline.expired ? '搜索服务请求超时。' : '搜索服务暂时无法连接。',
          },
          cause
        ),
      };
    } finally {
      deadline.close();
    }
  }
  private async sendSearchRequest(
    request: SearchRequest,
    apiKey: string,
    signal: AbortSignal
  ): Promise<Result<SearchResult>> {
    const { config } = this.options;
    const response = await (this.options.fetchImpl ?? fetch)(config.baseURL + '/messages', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'x-api-key': apiKey,
        authorization: 'Bearer ' + apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Perform a web search for the query: ' + request.query },
            ],
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config.maxUses }],
      }),
    });
    const decoded = decodeSearchResponse(
      response,
      await response.text(),
      request.maxResults ?? 5,
      config.baseURL
    );
    return 'failure' in decoded
      ? { ok: false, error: this.searchFailure(decoded.failure) }
      : { ok: true, value: decoded.result };
  }
  private searchFailure(cause: SearchFailureCause, diagnostic: unknown = cause): ContractFailure {
    return Object.freeze({
      code: 'UPSTREAM_FAILED',
      retry: cause.kind === 'quota-exhausted' ? 'after-change' : 'safe',
      cause: Object.freeze(cause),
      errorId: this.options.logger.cause(diagnostic, 'web-search'),
    });
  }
}
function validSearchRequest(request: SearchRequest): boolean {
  return (
    !!request.query.trim() &&
    request.query.length <= 8000 &&
    (request.maxResults === undefined ||
      (Number.isInteger(request.maxResults) && request.maxResults >= 1 && request.maxResults <= 20))
  );
}
/** Deadline owns its timer; caller cancellation remains attached throughout HTTP. */
function searchDeadline(clock: TaskClock, timeoutMs: number, signal: AbortSignal) {
  const controller = new AbortController();
  const timer = clock.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    get expired() {
      return controller.signal.aborted;
    },
    close() {
      clock.clearTimeout(timer);
    },
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function decodeSearchResponse(
  response: Pick<Response, 'ok' | 'status'>,
  text: string,
  limit: number,
  provider: string
): DecodedSearch {
  if (Buffer.byteLength(text) > 512 * 1024)
    return {
      failure: {
        kind: 'service-error',
        provider,
        httpStatus: response.status,
        message: '搜索返回超过容量。',
      },
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const upstream = providerError(raw);
  if (!response.ok || upstream)
    return { failure: searchFailureCause(response.status, upstream, provider) };
  const result = searchResults(raw, limit);
  return result
    ? { result }
    : {
        failure: {
          kind: 'service-error',
          provider,
          httpStatus: response.status,
          message: '搜索服务未返回有效搜索结果。',
        },
      };
}
function searchFailureCause(
  status: number,
  upstream: ApiError | undefined,
  provider: string
): SearchFailureCause {
  const message = upstream?.message ?? '搜索服务返回 HTTP ' + String(status) + '。';
  const quota = explicitMonthlyQuota(message, upstream?.code);
  return {
    kind: quota ? 'quota-exhausted' : 'service-error',
    provider,
    httpStatus: status,
    providerCode: upstream?.code,
    message,
    resetAt: quota ? /reset at ([^.]+)\./iu.exec(message)?.[1] : undefined,
  };
}
function providerError(raw: unknown): ApiError | undefined {
  const body = record(raw);
  if (typeof body?.error === 'string') return { message: body.error };
  const error = record(body?.error);
  if (error)
    return {
      message: stringValue(error.message) ?? '搜索服务返回错误。',
      code: stringValue(error.code) ?? stringValue(error.type),
    };
  return searchToolItems(raw)
    .map(toolError)
    .find((error) => error !== undefined);
}
function toolError(item: Record<string, unknown>): ApiError | undefined {
  if (item.type !== 'web_search_tool_result_error') return undefined;
  return {
    message: stringValue(item.message) ?? '搜索工具返回错误。',
    code: stringValue(item.error_code),
  };
}
/** Search results and embedded errors share one provider-owned block shape. */
function searchToolItems(raw: unknown): Record<string, unknown>[] {
  return records(record(raw)?.content)
    .filter((block) => block.type === 'web_search_tool_result')
    .flatMap((block) =>
      Array.isArray(block.content) ? records(block.content) : records([block.content])
    );
}
function explicitMonthlyQuota(message: string, code?: string): boolean {
  return (
    ['monthly_quota_exceeded', 'monthly_usage_quota_exceeded', 'monthly_quota_exhausted'].includes(
      code ?? ''
    ) || /\bYou have exceeded the monthly usage quota\b/iu.test(message)
  );
}
function searchCitations(raw: unknown): Map<string, string> {
  const citations = records(record(raw)?.content)
    .filter((block) => block.type === 'text')
    .flatMap((block) => records(block.citations));
  const snippets = new Map<string, string>();
  for (const citation of citations)
    if (
      typeof citation.url === 'string' &&
      typeof citation.cited_text === 'string' &&
      !snippets.has(citation.url)
    )
      snippets.set(citation.url, citation.cited_text);
  return snippets;
}
function searchSource(
  item: Record<string, unknown>,
  snippets: Map<string, string>
): SearchSource | undefined {
  if (item.type !== 'web_search_result' || typeof item.url !== 'string' || !URL.canParse(item.url))
    return undefined;
  const url = new URL(item.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.href.length > 2048) return undefined;
  return {
    url: url.href,
    title: stringValue(item.title)?.slice(0, 200),
    snippet: snippets.get(item.url)?.slice(0, 1024),
    publishedAt: stringValue(item.page_age)?.slice(0, 100),
  };
}
function searchResults(raw: unknown, limit: number): SearchResult | undefined {
  if (
    !records(record(raw)?.content).some(
      (block) => block.type === 'web_search_tool_result' && Array.isArray(block.content)
    )
  )
    return undefined;
  const snippets = searchCitations(raw);
  const found = searchToolItems(raw)
    .map((item) => searchSource(item, snippets))
    .filter((source): source is SearchSource => !!source);
  const unique = [...new Map(found.map((source) => [source.url, source])).values()];
  const result: SearchResult = {
    sources: unique.slice(0, limit),
    truncated: unique.length > limit,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > 32768) {
    result.sources.pop();
    result.truncated = true;
  }
  return result;
}
