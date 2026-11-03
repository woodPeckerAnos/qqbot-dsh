import type { DeepReadonly } from '../readonly.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { NormalizedMessage } from '../core/connector.js';
import type { DocumentExtractor, FileIngestResult } from '../dsh/files.js';
import type { PromptContentBlock } from '../dsh/protocol.js';
import type { ConversationStore } from '../store/conversations.js';
import type { StorePaths } from '../store/paths.js';
import type { ObservationWindowStore } from '../store/window.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { PipelineStats } from '../pipeline/stats.js';
import type { TopicJudge } from '../pipeline/topic-judge.js';
import type { TaskSnapshot, TaskInput } from './types.js';
import type { TaskClock } from './clock.js';
interface PreparedPrompt {
    blocks: PromptContentBlock[];
    /** 这条消息里一共认出几张图 */
    totalImages: number;
    /** 其中成功编码成 image block 的张数（只算**当前这条消息**） */
    inlinedImages: number;
    /**
     * 滚窗**上下文**里成功内联的**源图张数**（长图切片只算一张）。
     *
     * 与 `inlinedImages` 分开计、且单位不同（那个数的是 block）——口径写在这里，
     * 是因为"模型看不到的到底是刚发的那张还是背景里的那张"必须能从统计上回答。
     */
    windowImagesInlined: number;
    /** 上下文里没能送进 prompt 的源图张数（配额不够 / 下载失败 / 格式不支持 / 解不开） */
    windowImagesSkipped: number;
    /** 从上下文里取到字节的文件数（摄取明细已并进 `files`） */
    windowFilesFetched: number;
    /**
     * 文件摄取的计数（当前这条消息 + 上下文里被选中的文件）。准备结果按 Task
     * 缓存，准备完成时只计一次；两个 lane 复用结果，不重复计入摄取统计。
     */
    files: FileIngestCounts;
}
/** 文件摄取的计数（ingestFiles 的结果去掉 notes） */
type FileIngestCounts = Omit<FileIngestResult, 'notes'>;
export interface PromptPreparer {
    /** 排除当前用户消息，避免 Ingress 已记录的输入又通过回放重复注入。 */
    capture(message: NormalizedMessage, sinceTs?: number): TaskInput['context'];
    judge(message: NormalizedMessage, context: TaskInput['context']): Promise<import('../pipeline/topic-judge.js').TopicVerdict>;
    /** 创建所属 Task 目录并继承会话规则，输入文件与交付物均在该目录内。 */
    workspace(task: DeepReadonly<TaskSnapshot>): string;
    /** Promise 本身缓存；并行 lane 不重复下载，失败也由两个 lane 各自显式收尾。 */
    prepare(task: DeepReadonly<TaskSnapshot>, ctx: MessageContext): Promise<PreparedPrompt>;
    /** 双 lane 完成后释放内存，磁盘工作区继续按 Task 保留期保存。 */
    release(taskId: string): void;
    removeWorkspace(task: DeepReadonly<TaskSnapshot>): Promise<void>;
}
export type createPromptPreparerFactory = (deps: {
    config: Config;
    logger: Logger;
    conversations: ConversationStore;
    windows?: ObservationWindowStore;
    paths: StorePaths;
    stats: PipelineStats;
    extractDocument?: DocumentExtractor;
    topicJudge?: TopicJudge;
    topicJudgeResult?: import('../pipeline/topic-judge.js').TopicJudgeResult;
    clock?: TaskClock;
}) => PromptPreparer;
export {};
