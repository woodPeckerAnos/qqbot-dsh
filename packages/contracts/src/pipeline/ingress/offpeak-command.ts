/**
 * Ingress stage ②：/offpeak 命令路由（终态 stage）。
 *
 * 位置理由：必须先于谷时段闸——管理员必须能在峰时段发命令关闸。
 * 命令整个流程不触碰对话记录、并发名额与 DSH runtime。
 *
 * 权限模型：status / whoami 对所有人开放（不消耗 API，且 whoami 是管理员
 * 发现自己平台身份的唯一入口）；变更类操作（on/off/window/holiday/reset）
 * 仅管理员。白名单为空时变更类命令对所有人关闭——fail-closed。
 *
 * 与 dispatcher 解耦的关键：本 stage 只依赖 OffpeakGate 服务（配置与持久化）
 * 和 ctx.responder（回执），不知道 turn 的存在。
 */
/**
 * Ingress stage ②：/offpeak 命令路由（终态 stage）。
 *
 * 位置理由：必须先于谷时段闸——管理员必须能在峰时段发命令关闸。
 * 命令整个流程不触碰对话记录、并发名额与 DSH runtime。
 *
 * 权限模型：status / whoami 对所有人开放（不消耗 API，且 whoami 是管理员
 * 发现自己平台身份的唯一入口）；变更类操作（on/off/window/holiday/reset）
 * 仅管理员。白名单为空时变更类命令对所有人关闭——fail-closed。
 *
 * 与 dispatcher 解耦的关键：本 stage 只依赖 OffpeakGate 服务（配置与持久化）
 * 和 ctx.responder（回执），不知道 turn 的存在。
 */
import type { Config } from '../../config.js';
import type { OffpeakGate } from '../../offpeak/index.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';
export interface OffpeakCommandRouter {
  stage(): IngressStage;
}
export type createOffpeakCommandRouterFactory = (deps: {
  gate: OffpeakGate;
  config: Config;
  stats: PipelineStats;
  now?: () => number;
}) => OffpeakCommandRouter;
