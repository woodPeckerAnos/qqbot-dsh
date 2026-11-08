import type {
  classifyTaskFollowUp,
  MessagePart,
  TaskSnapshotV2,
  DeepReadonly,
} from '@qqbot/contracts';

type FollowUpOptions = Parameters<classifyTaskFollowUp>[0];
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
function replyTexts(task: DeepReadonly<TaskSnapshotV2>): string[] {
  return Object.values(task.lanes).flatMap((lane) =>
    lane.result?.kind === 'reply' && lane.result.text.trim() ? [lane.result.text.trim()] : []
  );
}
function recentReply(task: DeepReadonly<TaskSnapshotV2>, options: FollowUpOptions): boolean {
  if (task.status !== 'completed' || task.endedAt === undefined) return false;
  return (
    task.endedAt <= options.now &&
    task.endedAt >= options.now - (options.recentTaskWindowMs ?? 300000) &&
    replyTexts(task).length > 0
  );
}
function sameIdentity(task: DeepReadonly<TaskSnapshotV2>, options: FollowUpOptions): boolean {
  return (
    task.creationSequence < (options.beforeSequence ?? Infinity) &&
    task.input.message.target.key === options.message.target.key &&
    task.input.generation === options.generation &&
    task.input.message.senderId === options.message.senderId
  );
}
function candidate(task: DeepReadonly<TaskSnapshotV2>, options: FollowUpOptions): boolean {
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
export const classifyFollowUp: classifyTaskFollowUp = (options) => {
  const input = inputText(options.message);
  if (!input) return {};
  const targets = options.tasks
    .filter((task) => candidate(task, options))
    .filter(
      (task) =>
        input.quote === undefined ||
        [task.input.message.content.trim(), ...replyTexts(task)].includes(input.quote)
    );
  const target = targets[0];
  if (targets.length !== 1 || !target) return {};
  const progressOnly = input.text.length <= 40 && PROGRESS.test(input.text);
  if (!progressOnly && !input.quote && !POINTER.test(input.text)) return {};
  return { followUpOf: target.taskId, ...(progressOnly ? { progressOnly: true } : {}) };
};
