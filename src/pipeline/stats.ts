/**
 * 管线统计：各 stage 自报计数，Orchestrator 聚合成快照。
 *
 * 设计约定：
 *   - 计数器是公共数值字段，哪个 stage 拥有哪个字段在各自的文件头注释里写明；
 *   - 快照（snapshotStats）在这里的字段之外再附上 inFlight / queued / offpeak，
 *     它们不是计数而是状态，归准入闸门与谷时段闸服务所有；
 *   - health 端点原样展示快照，不在此层做格式化。
 */

import type { OffpeakSnapshot } from '../offpeak/index.js';

export class PipelineStats {
  /** 收到的用户消息数（Orchestrator 入口） */
  received = 0;
  /** 事件去重丢弃数（dedupe stage） */
  deduplicated = 0;
  /** 并发满员拒绝数（admission stage） */
  rejectedBusy = 0;
  /** 单聊开关拦截数（Orchestrator 入口，去重之前） */
  skippedC2C = 0;
  /** 谷时段闸拦截数（offpeak-gate stage） */
  gatedOffpeak = 0;
  /** 处理过的 /offpeak 命令数（offpeak-command stage） */
  adminCommands = 0;
  /** 处理过的 /stop、/new 会话控制命令数（session-command stage） */
  sessionCommands = 0;
  /** 话题间隔超阈值触发上下文重置的次数（TurnRunner） */
  topicResets = 0;
  /** 会话锁忙时发出的"排队提示"条数（admission stage） */
  busyNoticed = 0;
  /** turn 正常完成数（TurnRunner） */
  completed = 0;
  /** turn 未预期错误数（admission stage 兜底） */
  failed = 0;
  /** turn 超时数（TurnRunner） */
  timedOut = 0;
  /** 后台子代理启动数（main.ts，来自 pool 的 subagent.started） */
  backgroundStarted = 0;
  /** 后台子代理结束数（main.ts，来自 pool 的 subagent.finished） */
  backgroundFinished = 0;
  /** 捕获到的"自发轮次"结果条数（TurnRunner，后台任务完成后父代理的总结） */
  backgroundCaptured = 0;
  /** 后台结果被主动推送出去的条数（BackgroundPusher：OneBot 即推 / 官方窗口内投递） */
  backgroundPushed = 0;
  /** 随下一条回复带出的后台结果条数（TurnRunner） */
  backgroundDelivered = 0;
  /** 因 sessionId 不匹配被过滤掉的子会话事件数（TurnRunner，串扰防护命中计数） */
  childEventsFiltered = 0;
  /** 成功内联进 prompt 的图片数（TurnRunner） */
  imagesInlined = 0;
  /** 读取失败/超限/格式不支持而跳过的图片数（TurnRunner） */
  imagesSkipped = 0;
  /** 成功展开的转发消息块数（连接器回查 get_forward_msg 成功后） */
  forwardsExpanded = 0;
  /** 实际渲染进 content 的转发条目数（连接器；受 maxNodes/maxChars 裁剪后） */
  forwardNodesInlined = 0;
  /** 回查失败/超时/关闭而未展开的转发块数（连接器，降级为 `[聊天记录]`） */
  forwardsFailed = 0;
  /** 成功取到字节的文件数（TurnRunner） */
  filesFetched = 0;
  /** 成功抽取正文的文件数（TurnRunner） */
  filesExtracted = 0;
  /** 只落盘、未抽取正文的文件数（TurnRunner；类型不支持或解析器不可用） */
  filesSavedOnly = 0;
  /** 因关闭/超体积/超出数量/失败而跳过的文件数（TurnRunner / 连接器） */
  filesSkipped = 0;
  /** 送入 prompt 的文件正文字符数（TurnRunner） */
  fileCharsInlined = 0;
  /** 成功发出的回复段数（Responder / 欢迎语） */
  repliesSent = 0;
  /** 成功发出的附件数（Responder；附件消息同时计入 repliesSent） */
  attachmentsSent = 0;
  /** 成功发出的进度回执数（Responder） */
  progressSent = 0;
}

/** health 端点展示用的完整快照：计数 + 准入闸门状态 + 谷时段闸状态。 */
export type PipelineStatsSnapshot = {
  [K in keyof PipelineStats]: number;
} & {
  inFlight: number;
  queued: number;
  offpeak: OffpeakSnapshot;
};
