/** Safe metadata only: never include response text, reasoning, request bodies or error messages. */
export interface JudgmentDiagnostics {
  requestModel?: string;
  responseModel?: string;
  httpStatus?: number;
  finishReason?: string;
  contentLength?: number;
  reasoningLength?: number;
  attempts?: number;
  retryCount?: number;
}
export type JudgmentFailureClass =
  'network' | 'http' | 'timeout' | 'parse' | 'response-contract' | 'unknown';
export type JudgmentResult<T> = (
  { ok: true; value: T } | { ok: false; failureClass: JudgmentFailureClass }
) & { diagnostics: JudgmentDiagnostics };
export interface JudgeCircuitSnapshot {
  state: 'closed' | 'cooldown' | 'probe-ready' | 'probing';
  consecutiveFailures: number;
  reason?: JudgmentFailureClass;
  pausedAt?: number;
  nextProbeAt?: number;
}
