/**
 * 管线统计：各 stage 自报计数，Orchestrator 聚合成快照。
 *
 * 设计约定：
 *   - 计数器是公共数值字段，哪个 stage 拥有哪个字段在各自的文件头注释里写明；
 *   - 快照（snapshotStats）在这里的字段之外再附上 inFlight / queued / offpeak，
 *     它们不是计数而是状态，归准入闸门与谷时段闸服务所有；
 *   - health 端点原样展示快照，不在此层做格式化。
 */

import type { InterventionSnapshot } from '../intervention/watcher.js';
import type { OffpeakSnapshot } from '../offpeak/index.js';

export class PipelineStats {
  /** 收到的用户消息数（Orchestrator 入口） */
  received = 0;
  /** 旁听到的群消息数（TopicWatcher 入口，未 @ 机器人） */
  observed = 0;
  /** 旁听消息被介入规则链拦截数（TopicWatcher；按规则名的明细在 watcher 快照里） */
  observedHalted = 0;
  /** 续聊晋升数（TopicWatcher：observed 消息还原成正常提问回投编排层，含合并冲刷） */
  continuationsPromoted = 0;
  /** 续聊晋升转入 pending 合并队列数（TopicWatcher：turn 在途时的落点） */
  continuationsMerged = 0;
  /** pending 队列淘汰/作废数（TopicWatcher：超限丢最旧、过期、窗口已关） */
  continuationsDropped = 0;
  /** Gate 判定调用数（TopicWatcher；经计数包装） */
  gateCalls = 0;
  /** Gate 判定失败数（超时/HTTP 错/输出无法解析——fail-closed 为 silent） */
  gateErrors = 0;
  /** 介入 turn 实际发起数（TopicWatcher：speak 链全过且准入 try 成功） */
  interventionsSent = 0;
  /** 介入因准入 try 被拒放弃数（并发满/会话锁占；绝不排队） */
  interventionsDroppedBusy = 0;
  /** dryRun 灰度期判定应发言但未投递数 */
  interventionsDryRun = 0;
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
  /** 成功发出的回复段数（Responder / 欢迎语） */
  repliesSent = 0;
  /** 成功发出的附件数（Responder；附件消息同时计入 repliesSent） */
  attachmentsSent = 0;
  /** 成功发出的进度回执数（Responder） */
  progressSent = 0;
}

/** health 端点展示用的完整快照：计数 + 准入闸门状态 + 谷时段闸状态 + 介入层状态。 */
export type PipelineStatsSnapshot = {
  [K in keyof PipelineStats]: number;
} & {
  inFlight: number;
  queued: number;
  offpeak: OffpeakSnapshot;
  intervention: InterventionSnapshot;
};
