import type { DshRuntime, DshRuntimeOptions, SessionEventNotification } from '@qqbot/contracts';
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
    const reasoning: ReasoningEvidence = { taskId, lane, appeared: false, events: 0, tokens: 0 };
    const execution: ExecutionEvidence = {
      taskId,
      lane,
      modelFinalText: '',
      toolCalls: 0,
      toolErrors: 0,
      childrenStarted: 0,
      childrenFinished: 0,
      childFailures: 0,
    };
    const taskControl = options.taskControl;
    if (taskControl)
      options.taskControl = (request) => {
        const result = taskControl(request);
        if (request.action === 'query') {
          execution.taskQueries ??= [];
          execution.taskQueries.push({
            taskId: request.taskId,
            at: now(),
            result: structuredClone(result),
          });
        }
        return result;
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
      if (n.event.type === 'tool/call') {
        execution.toolCalls++;
        const data = n.event.data as { name?: string; call?: { name?: string } };
        execution.toolNames ??= [];
        execution.toolNames.push(data.name ?? data.call?.name ?? 'unknown');
      }
      if (n.event.type === 'tool/result') {
        if (hasToolError(n.event.data)) execution.toolErrors++;
        else {
          execution.toolResultUuids ??= [];
          execution.toolResultUuids.push(...extractToolResultUuids(n.event.data));
        }
      }
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
    runtime.prompt = (sessionId, blocks) => {
      parent = sessionId;
      execution.promptAt = now();
      const block = blocks.find(
        (entry) =>
          entry.type === 'text' && entry.text.startsWith('当前输入是唯一执行项。以下是只读背景')
      );
      if (block?.type === 'text') {
        try {
          const json = block.text.match(/<转发内容>\n([\s\S]+)\n<\/转发内容>$/u)?.[1];
          execution.contextView = JSON.parse(json ?? '') as ExecutionEvidence['contextView'];
        } catch {
          execution.contextViewError = 'invalid-context-view';
        }
      }
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
  const object = data as {
    isError?: boolean;
    status?: string;
    error?: unknown;
    result?: { isError?: boolean };
  };
  return (
    object.isError === true ||
    object.status === 'error' ||
    object.error !== undefined ||
    object.result?.isError === true ||
    toolResultBlocks(data).some((block) => block.isError === true)
  );
}
function toolResultBlocks(data: unknown): { isError?: boolean; content?: unknown[] }[] {
  if (!data || typeof data !== 'object') return [];
  const object = data as { message?: { content?: unknown } };
  const content = object.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block) => block && typeof block === 'object' && block.type === 'tool-result'
  ) as { isError?: boolean; content?: unknown[] }[];
}
function extractToolResultUuids(data: unknown): string[] {
  return toolResultBlocks(data)
    .flatMap((block) => (Array.isArray(block.content) ? block.content : []))
    .flatMap((content) => {
      if (!content || typeof content !== 'object') return [];
      const text = content as { type?: string; text?: string };
      if (text.type !== 'text' || typeof text.text !== 'string') return [];
      return [
        ...text.text.matchAll(
          /\breceipt=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/giu
        ),
      ].map((value) => value[1]!.toLowerCase());
    });
}
