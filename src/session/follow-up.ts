import type {
  classifyTaskFollowUp,
  MessagePart,
  TaskSnapshotV2,
  TaskSnapshotV3,
  classifyTaskFollowUpV3,
  DeepReadonly,
} from '@qqbot/contracts';

type Task = DeepReadonly<TaskSnapshotV2 | TaskSnapshotV3>;
type FollowUpOptions = Omit<Parameters<classifyTaskFollowUp>[0], 'tasks'> & {
  tasks: readonly Task[];
};
const POINTER =
  /(?:(?:刚才那个|之前那个|上一个|上一项|刚才|之前|上个|那个|这个|这项|那项|这次|那次)(?:的)?(?:任务|问题|查询|核实|调查|检查|搜索|请求|事情|事|结果|回答)|原任务|这件事|那件事)/;
const PROGRESS =
  /^(?:(?:(?:刚才那个|之前那个|上一个|上一项|刚才|之前|上个|那个|这个|这项|那项|这次|那次)(?:的)?(?:任务|问题|查询|核实|调查|检查|搜索|请求|事情|事))|(?:这件事|那件事)|(?:你那边))?[，,：:\s]*(?:进度(?:怎样|如何|怎么样)|还没有核实完成吗|核实完成了吗|完成了吗|好了没|查到了吗|还在查吗|结果呢|有结果了吗|结果出来了吗|还要多久|什么时候完成|到哪一步了)[？?！!。.]*$/u;
const LINK_OR_MEDIA = /(?:https?:\/\/|www\.|\[[^\]]*(?:图片|文件|语音|视频|聊天记录))/i;

function plain(parts: readonly MessagePart[]): string | undefined {
  if (parts.some((part) => part.type !== 'text')) return undefined;
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}
function replyTexts(task: Task): string[] {
  if ('schemaVersion' in task)
    return [task.finalReply?.text, task.worker?.result?.text]
      .filter((text): text is string => !!text?.trim())
      .map((text) => text.trim());
  return Object.values(task.lanes).flatMap((lane) =>
    lane.result?.kind === 'reply' && lane.result.text.trim() ? [lane.result.text.trim()] : []
  );
}
function recentReply(task: Task, options: FollowUpOptions): boolean {
  if (!queryableResult(task) || task.endedAt === undefined) return false;
  return (
    task.endedAt <= options.now &&
    task.endedAt >= options.now - (options.recentTaskWindowMs ?? 300000) &&
    replyTexts(task).length > 0
  );
}
function queryableResult(task: Task): boolean {
  if (task.status === 'completed') return true;
  if (!('schemaVersion' in task) || task.status !== 'failed') return false;
  const result = task.worker?.result;
  return !!result && (!!result.text.trim() || result.attachments.length > 0);
}
function sameIdentity(task: Task, options: FollowUpOptions): boolean {
  return (
    task.creationSequence < (options.beforeSequence ?? Infinity) &&
    task.input.message.target.key === options.message.target.key &&
    task.input.generation === options.generation &&
    task.input.message.senderId === options.message.senderId
  );
}
function candidate(task: Task, options: FollowUpOptions): boolean {
  if (
    !sameIdentity(task, options) ||
    task.input.source !== 'user' ||
    task.input.progressOnly ||
    task.cancelAccepted
  )
    return false;
  return task.status === 'pending' || task.status === 'running' || recentReply(task, options);
}
function inputText(
  message: FollowUpOptions['message']
): { text: string; quote?: string } | undefined {
  const parts = message.parts;
  const quotes = parts?.filter((part) => part.type === 'quote') ?? [];
  if (quotes.length > 1) return undefined;
  const text = requestText(message);
  if (!text || LINK_OR_MEDIA.test(text)) return undefined;
  const quoted = quotes[0];
  if (!quoted) return { text };
  const quote = plain(quoted.parts);
  if (!quote || /(?:…|\.\.\.|截断)/u.test(quote) || LINK_OR_MEDIA.test(quote)) return undefined;
  return { text, quote };
}
function requestText(message: FollowUpOptions['message']): string | undefined {
  if (!message.parts) return message.content.trim();
  return plain(message.parts.filter((part) => part.type !== 'quote'));
}

/** Exact rules only: uncertain references and mixed requests retain normal execution. */
function classifyReference(options: FollowUpOptions): ReturnType<classifyTaskFollowUpV3> {
  const input = inputText(options.message);
  if (!input) return {};
  const retry =
    options.tasks.some((task) => 'schemaVersion' in task) && explicitRetryRequested(input.text);
  const selected = referenceTargets(options, input, retry);
  const target = selected[0];
  if (selected.length !== 1 || !target) return {};
  const progressOnly = pureProgress(input.text);
  if (!progressOnly && !retry && !referenceText(input)) return {};
  return {
    followUpOf: target.taskId,
    ...(progressOnly ? { progressOnly: true } : {}),
    ...(retry ? { retryOf: target.taskId } : {}),
  };
}
function explicitRetryRequested(text: string): boolean {
  return (
    /(?:重试|重新(?:执行|查|搜|调查|核实|做)|再(?:试一次|查一次|查一下|搜一次|做一次))/u.test(
      text
    ) &&
    !/["'“”‘’「」『』`]/u.test(text) &&
    !/(?:不要|不用|别|无需|不许|禁止|不想|不需要).*(?:重试|重新|再)/u.test(text)
  );
}
function referenceTargets(
  options: FollowUpOptions,
  input: { text: string; quote?: string },
  retry: boolean
): Task[] {
  const targets = options.tasks
    .filter((task) =>
      retry
        ? sameIdentity(task, options) && task.input.source === 'user' && task.status === 'failed'
        : candidate(task, options)
    )
    .filter(
      (task) =>
        input.quote === undefined ||
        [task.input.message.content.trim(), ...replyTexts(task)].includes(input.quote)
    );
  const named = retry ? targets.filter((task) => input.text.includes(task.taskId)) : [];
  return named.length ? named : targets;
}
export const classifyFollowUp: classifyTaskFollowUp = classifyReference;
export const classifyFollowUpV3: classifyTaskFollowUpV3 = classifyReference;

function pureProgress(text: string): boolean {
  return text.length <= 40 && PROGRESS.test(text);
}
function referenceText(input: { text: string; quote?: string }): boolean {
  return !!input.quote || POINTER.test(input.text);
}
