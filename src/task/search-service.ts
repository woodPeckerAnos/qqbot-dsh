import { failure, readonlySnapshot } from '@qqbot/contracts';
import type {
  ContractFailure,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchService as Service,
  Result,
} from '@qqbot/contracts';

/** One process owns quota state; queued searches check it immediately before HTTP. */
export class SearchRequestQueue implements Service {
  private firstQuota?: ContractFailure;
  private tail: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  constructor(private readonly provider: SearchProvider) {}
  quotaFailure(): ContractFailure | undefined {
    return this.firstQuota;
  }
  search(request: SearchRequest, signal: AbortSignal): Promise<Result<SearchResult>> {
    if (signal.aborted) return Promise.resolve({ ok: false, error: failure('CANCELLED') });
    if (this.shutdown.signal.aborted)
      return Promise.resolve({ ok: false, error: failure('CLOSED') });
    if (this.firstQuota) return Promise.resolve({ ok: false, error: this.firstQuota });
    const submitted = Object.freeze({ ...request });
    const work = this.tail.then(async (): Promise<Result<SearchResult>> => {
      if (signal.aborted) return { ok: false, error: failure('CANCELLED') };
      if (this.shutdown.signal.aborted) return { ok: false, error: failure('CLOSED') };
      if (this.firstQuota) return { ok: false, error: this.firstQuota };
      const combined = AbortSignal.any([signal, this.shutdown.signal]);
      let result: Result<SearchResult>;
      try {
        result = await this.provider.search(submitted, combined);
      } catch (cause) {
        result = {
          ok: false,
          error: failure(combined.aborted ? 'CANCELLED' : 'UPSTREAM_FAILED', cause),
        };
      }
      if (!result.ok && quotaCause(result.error.cause)) {
        this.firstQuota = readonlySnapshot({ ...result.error, retry: 'after-change' as const });
        return { ok: false, error: this.firstQuota };
      }
      return result;
    });
    this.tail = work.then(() => undefined);
    // Cancelling a queued caller releases it without waiting for unrelated HTTP.
    return new Promise((resolve) => {
      const abort = () => {
        resolve({ ok: false, error: failure('CANCELLED') });
      };
      signal.addEventListener('abort', abort, { once: true });
      void work.then(resolve).finally(() => {
        signal.removeEventListener('abort', abort);
      });
      if (signal.aborted) abort();
    });
  }
  close(): void {
    this.shutdown.abort();
  }
}
function quotaCause(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'quota-exhausted'
  );
}
