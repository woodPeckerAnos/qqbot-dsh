import type {
  DshRuntimeV2 as DshRuntime,
  DshRuntimeOptions,
  SessionEventNotification,
} from '@qqbot/contracts';
import type { ReasoningEvidence, ExecutionEvidence } from './types.js';
import { extractAssistantText } from '../../../src/runtime/index.js';

/** Observe metadata and visible final text only; never retain raw frames or reasoning bodies. */
export class RuntimeEvidence {
  activeObservers = 0;
  versions = new Set<string>();
  reasoning: ReasoningEvidence[] = [];
  executions: ExecutionEvidence[] = [];
  attach(runtime: DshRuntime, options: DshRuntimeOptions, now: () => number): DshRuntime {
    const taskId = options.cwd.split('/').at(-2) ?? '',
      lane = options.env?.QQBOT_LANE ?? '';
    let reasoning: ReasoningEvidence = { taskId, lane, appeared: false, events: 0, tokens: 0 };
    let execution: ExecutionEvidence = {
      taskId,
      lane,
      modelFinalText: '',
      toolCalls: 0,
      toolErrors: 0,
      childrenStarted: 0,
      childrenFinished: 0,
      childFailures: 0,
    };
    this.reasoning.push(reasoning);
    this.executions.push(execution);
    this.activeObservers++;
    let parent = '',
      closed = false;
    const sequences = new Map<string, number>(),
      children = new Set<string>(),
      finished = new Set<string>();
    const parents = new Map<string, string>();
    const event = (n: SessionEventNotification) => {
      if (
        closed ||
        finished.has(n.sessionId) ||
        (n.sessionId !== parent && !children.has(n.sessionId)) ||
        n.event.seq <= (sequences.get(n.sessionId) ?? -1)
      )
        return;
      sequences.set(n.sessionId, n.event.seq);
      reasoning.tokens += countReasoningTokens(n.event.data);
      if (/reasoning/i.test(n.event.type)) {
        reasoning.appeared = true;
        reasoning.events++;
      }
      reasoning.appeared ||= reasoning.tokens > 0;
      if (n.event.type === 'tool/call') execution.toolCalls++;
      if (n.event.type === 'tool/result' && hasToolError(n.event.data)) execution.toolErrors++;
      if (n.sessionId !== parent) return;
      const text = extractAssistantText(n.event);
      if (text) execution.modelFinalText = text;
      if (n.event.type === 'turn/end') execution.parentEndedAt = now();
    };
    const started: import('@qqbot/contracts').DshRuntimeEvents['subagent.started'] = (n) => {
      if (
        closed ||
        (n.parentSessionId !== parent && !children.has(n.parentSessionId)) ||
        children.has(n.childSessionId)
      )
        return;
      children.add(n.childSessionId);
      parents.set(n.childSessionId, n.parentSessionId);
      execution.childrenStarted++;
    };
    const ended: import('@qqbot/contracts').DshRuntimeEvents['subagent.finished'] = (n) => {
      if (
        closed ||
        parents.get(n.childSessionId) !== n.parentSessionId ||
        finished.has(n.childSessionId)
      )
        return;
      finished.add(n.childSessionId);
      execution.childrenFinished++;
      if (n.status === 'error') execution.childFailures++;
      execution.lastChildFinishedAt = now();
    };
    runtime.on('session.event', event);
    runtime.on('subagent.started', started);
    runtime.on('subagent.finished', ended);
    const start = runtime.start.bind(runtime),
      prompt = runtime.prompt.bind(runtime),
      dispose = runtime.dispose.bind(runtime);
    runtime.start = async () => {
      const result = await start();
      this.versions.add(result.serverInfo.version ?? 'unknown');
      return result;
    };
    const bind = runtime.bindExecution.bind(runtime),
      unbind = runtime.unbindExecution.bind(runtime);
    let firstBinding = true;
    runtime.bindExecution = (binding, handlers) => {
      if (!firstBinding) {
        reasoning = { taskId: binding.taskId, lane, appeared: false, events: 0, tokens: 0 };
        execution = {
          taskId: binding.taskId,
          lane,
          modelFinalText: '',
          toolCalls: 0,
          toolErrors: 0,
          childrenStarted: 0,
          childrenFinished: 0,
          childFailures: 0,
        };
        this.reasoning.push(reasoning);
        this.executions.push(execution);
      } else {
        reasoning.taskId = execution.taskId = binding.taskId;
        firstBinding = false;
      }
      if (closed) this.activeObservers++;
      closed = false;
      sequences.clear();
      children.clear();
      finished.clear();
      parents.clear();
      return bind(binding, handlers);
    };
    runtime.unbindExecution = async (binding) => {
      const ack = await unbind(binding);
      if (!closed) {
        closed = true;
        this.activeObservers--;
      }
      return ack;
    };
    runtime.prompt = (sessionId, blocks) => {
      parent = sessionId;
      return prompt(sessionId, blocks);
    };
    runtime.dispose = async () => {
      try {
        await dispose();
      } finally {
        if (!closed) {
          closed = true;
          this.activeObservers--;
        }
        runtime.off('session.event', event);
        runtime.off('subagent.started', started);
        runtime.off('subagent.finished', ended);
      }
    };
    return runtime;
  }
}
export function countReasoningTokens(data: unknown, depth = 0): number {
  if (depth > 6 || !data || typeof data !== 'object') return 0;
  return Object.entries(data).reduce((sum, [key, value]) => {
    if (
      /^reasoning_?tokens$/i.test(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    )
      return sum + value;
    return sum + countReasoningTokens(value, depth + 1);
  }, 0);
}
function hasToolError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const object = data as { isError?: boolean; status?: string; result?: { isError?: boolean } };
  return object.isError === true || object.status === 'error' || object.result?.isError === true;
}
