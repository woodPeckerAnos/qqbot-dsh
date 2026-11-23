import { failure } from '@qqbot/contracts';
import type { ContractFailure, DeepReadonly, WorkerResult } from '@qqbot/contracts';

export interface TurnDataV3 {
  text: string;
  evidence: string[];
}

export type TurnResultV3 =
  | { kind: 'completed'; data: TurnDataV3 }
  | { kind: 'failed'; failure: ContractFailure; message: string; partialData: TurnDataV3 }
  | { kind: 'dispatched' };

/** 诊断只留在失败契约中；这些说明可以交给整理模型和用户。 */
export function workerFailureMessage(error: DeepReadonly<ContractFailure>): string {
  switch (error.code) {
    case 'CANCELLED':
      return '已按要求停止，现有内容已保留。';
    case 'UNKNOWN_OUTCOME':
      return '处理意外中断，完成情况暂时无法确认。';
    case 'TIMEOUT':
      return '处理超时，现有内容已保留，完成情况仍需核实。';
    case 'INVALID_INPUT':
      return '有内容或文件未通过检查，已保留有效内容。';
    default:
      return '处理未能顺利结束，现有内容已保留。';
  }
}

export function failedTurn(
  error: ContractFailure,
  partialData: TurnDataV3 = { text: '', evidence: [] }
): Extract<TurnResultV3, { kind: 'failed' }> {
  return { kind: 'failed', failure: error, message: workerFailureMessage(error), partialData };
}

/** 收尾错误保留已选定的失败分类，取消始终优先。 */
export function recordTurnFailure(turn: TurnResultV3, error: ContractFailure): TurnResultV3 {
  if (turn.kind === 'failed' && error.code !== 'CANCELLED') return turn;
  if (turn.kind === 'dispatched') return turn;
  return failedTurn(error, turn.kind === 'completed' ? turn.data : turn.partialData);
}

export function failedWorker(
  error: ContractFailure,
  partialData: TurnDataV3 = { text: '', evidence: [] }
): WorkerResult {
  let status: WorkerResult['status'] = 'failed';
  if (error.code === 'CANCELLED') status = 'cancelled';
  if (error.code === 'UNKNOWN_OUTCOME') status = 'unknown';
  return {
    status,
    text: partialData.text.trim(),
    evidence: [...partialData.evidence],
    attachments: [],
    unfinished: [workerFailureMessage(error)],
    failure: structuredClone(error),
  };
}

export function workerResultFromTurn(turn: TurnResultV3): WorkerResult {
  if (turn.kind === 'failed') return failedWorker(turn.failure, turn.partialData);
  if (turn.kind === 'dispatched') return failedWorker(failure('INVALID_INPUT'));
  return {
    status: 'completed',
    text: turn.data.text.trim(),
    evidence: [...turn.data.evidence],
    attachments: [],
    unfinished: [],
  };
}

export function recordWorkerFailure(result: WorkerResult, error: ContractFailure): WorkerResult {
  const selected = error.code === 'CANCELLED' ? error : (result.failure ?? error);
  const failed = failedWorker(selected, result);
  return {
    ...failed,
    attachments: result.attachments,
    unfinished: [...new Set([...result.unfinished, workerFailureMessage(error)])],
  };
}

export function workerResultMessage(result: DeepReadonly<WorkerResult>): string {
  if (result.failure) return workerFailureMessage(result.failure);
  if (result.status === 'completed') return '本次处理已正常结束。';
  if (result.status === 'unknown') return workerFailureMessage(failure('UNKNOWN_OUTCOME'));
  if (result.status === 'cancelled') return workerFailureMessage(failure('CANCELLED'));
  return workerFailureMessage(failure('UPSTREAM_FAILED'));
}
