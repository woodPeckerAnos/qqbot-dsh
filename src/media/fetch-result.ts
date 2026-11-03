import { failure, MEDIA_FAILURE_CODES, SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  MediaBytes,
  MediaFetchDependencies,
  MediaFetchFailure,
  MediaFetchOptions,
  MediaFetchResult,
  MediaFetchSource,
  MediaFailureReason,
  RemoteMedia,
} from '@qqbot/contracts';

function failedRead(
  reason: MediaFailureReason,
  source: MediaFetchSource,
  dependencies: MediaFetchDependencies,
  details: { cause?: unknown; httpStatus?: number; maxBytes?: number; actualBytes?: number } = {}
): MediaFetchResult {
  const cause = details.cause ?? new Error(`media-${reason}`);
  const errorId = dependencies.logger?.cause(cause, `media-${reason}`);
  const error: MediaFetchFailure = Object.freeze({
    ...failure(MEDIA_FAILURE_CODES[reason], cause, errorId),
    reason,
    source,
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    ...(details.maxBytes !== undefined ? { maxBytes: details.maxBytes } : {}),
    ...(details.actualBytes !== undefined ? { actualBytes: details.actualBytes } : {}),
  });
  return Object.freeze({ ok: false, error });
}

function validOptions(options: MediaFetchOptions): boolean {
  return (
    Number.isSafeInteger(options.maxBytes) &&
    options.maxBytes > 0 &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  );
}

function isMediaBytes(value: unknown): value is MediaBytes {
  return (
    value !== null &&
    typeof value === 'object' &&
    'data' in value &&
    value.data instanceof Uint8Array &&
    (!('mimeType' in value) || value.mimeType === undefined || typeof value.mimeType === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isMediaFailure(value: unknown): value is MediaFetchFailure {
  if (!isRecord(value) || typeof value.reason !== 'string') return false;
  if (!Object.hasOwn(MEDIA_FAILURE_CODES, value.reason)) return false;
  const reason = value.reason as MediaFailureReason;
  return (
    value.code === MEDIA_FAILURE_CODES[reason] &&
    typeof value.retry === 'string' &&
    ['safe', 'never', 'after-change'].includes(value.retry) &&
    typeof value.source === 'string' &&
    ['network', 'legacy', 'typed'].includes(value.source)
  );
}

function typedOutcome(
  value: unknown,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies
): MediaFetchResult {
  if (value === undefined) return failedRead('missing-result', 'typed', dependencies);
  if (!isRecord(value)) return failedRead('invalid-result', 'typed', dependencies);
  if (value.ok === true) return acceptedBytes(value.value, options, 'typed', dependencies);
  if (value.ok !== false || !isMediaFailure(value.error))
    return failedRead('invalid-result', 'typed', dependencies);
  const error = value.error;
  const errorId = error.errorId ?? dependencies.logger?.cause(error.cause, `media-${error.reason}`);
  return Object.freeze({ ok: false, error: Object.freeze({ ...error, errorId }) });
}

function acceptedBytes(
  value: unknown,
  options: MediaFetchOptions,
  source: MediaFetchSource,
  dependencies: MediaFetchDependencies
): MediaFetchResult {
  if (value === undefined) return failedRead('missing-result', source, dependencies);
  if (!isMediaBytes(value)) return failedRead('invalid-result', source, dependencies);
  if (value.data.byteLength > options.maxBytes)
    return failedRead('byte-limit', source, dependencies, {
      maxBytes: options.maxBytes,
      actualBytes: value.data.byteLength,
    });
  const bytes: MediaBytes = {
    data: new Uint8Array(value.data),
    ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
  };
  return Object.freeze({ ok: true, value: Object.freeze(bytes) });
}

function httpSource(media: RemoteMedia): MediaFailureReason | undefined {
  if (media.url === undefined)
    return media.fileId === undefined ? 'missing-source' : 'unsupported-source';
  try {
    const url = new URL(media.url);
    return ['http:', 'https:'].includes(url.protocol) ? undefined : 'unsupported-source';
  } catch {
    return 'unsupported-source';
  }
}

async function responseBytes(
  response: Response,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies,
  signal: AbortSignal
): Promise<MediaFetchResult> {
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    void response.body?.cancel().catch(() => {});
    return failedRead('byte-limit', 'network', dependencies, {
      maxBytes: options.maxBytes,
      actualBytes: declaredLength,
    });
  }
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (response.body === null)
    return acceptedBytes(
      { data: new Uint8Array(await response.arrayBuffer()), mimeType },
      options,
      'network',
      dependencies
    );
  return streamedBytes(response.body, mimeType, options, dependencies, signal);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  const chunk = await reader.read();
  if (signal.aborted) void reader.cancel().catch(() => {});
  signal.throwIfAborted();
  return chunk;
}

async function streamedBytes(
  body: ReadableStream<Uint8Array>,
  mimeType: string | undefined,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies,
  signal: AbortSignal
): Promise<MediaFetchResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let chunk = await readChunk(reader, signal);
    while (!chunk.done) {
      total += chunk.value.byteLength;
      if (total > options.maxBytes) {
        void reader.cancel().catch(() => {});
        return failedRead('byte-limit', 'network', dependencies, {
          maxBytes: options.maxBytes,
          actualBytes: total,
        });
      }
      chunks.push(chunk.value);
      chunk = await readChunk(reader, signal);
    }
  } finally {
    reader.releaseLock();
  }
  return acceptedBytes(
    { data: mergeChunks(chunks, total), mimeType },
    options,
    'network',
    dependencies
  );
}

function mergeChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function networkRead(
  media: RemoteMedia,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies,
  signal: AbortSignal
): Promise<MediaFetchResult> {
  const sourceError = httpSource(media);
  if (sourceError) return failedRead(sourceError, 'network', dependencies);
  const response = await (dependencies.fetchImpl ?? fetch)(media.url ?? '', { signal });
  if (signal.aborted) void response.body?.cancel().catch(() => {});
  signal.throwIfAborted();
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return failedRead('upstream-http', 'network', dependencies, { httpStatus: response.status });
  }
  return responseBytes(response, options, dependencies, signal);
}

async function readSource(
  media: RemoteMedia,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies,
  signal: AbortSignal
): Promise<MediaFetchResult> {
  if (dependencies.fetchResult) {
    const result = await dependencies.fetchResult(structuredClone(media), { ...options }, signal);
    signal.throwIfAborted();
    return typedOutcome(result, options, dependencies);
  }
  if (dependencies.fetchMedia) {
    const value = await dependencies.fetchMedia(structuredClone(media), { ...options });
    signal.throwIfAborted();
    return acceptedBytes(value, options, 'legacy', dependencies);
  }
  return networkRead(media, options, dependencies, signal);
}

function thrownReason(cause: unknown, timedOut: boolean): MediaFailureReason {
  const timeoutError =
    cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name);
  return timedOut || timeoutError ? 'timeout' : 'upstream-failed';
}

function sourceName(dependencies: MediaFetchDependencies): MediaFetchSource {
  if (dependencies.fetchResult) return 'typed';
  if (dependencies.fetchMedia) return 'legacy';
  return 'network';
}

/** Media read capability: one attempt, bounded bytes/time, isolated inputs and outputs. */
export async function fetchMediaResult(
  media: RemoteMedia,
  options: MediaFetchOptions,
  dependencies: MediaFetchDependencies = {}
): Promise<MediaFetchResult> {
  const source = sourceName(dependencies);
  const input = structuredClone(media);
  const limits = { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs };
  if (!validOptions(limits)) return failedRead('invalid-options', source, dependencies);
  const clock = dependencies.clock ?? SYSTEM_CLOCK;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MediaFetchResult>((resolveTimeout) => {
    timer = clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolveTimeout(failedRead('timeout', source, dependencies));
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([
      readSource(input, limits, dependencies, controller.signal),
      timeout,
    ]);
  } catch (cause) {
    return failedRead(thrownReason(cause, timedOut), source, dependencies, { cause });
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}
