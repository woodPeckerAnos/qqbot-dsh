/**
 * Ingress stage ③：谷时段闸（DeepSeek 错峰优惠时段之外直接拒答，不调 API）。
 *
 * 位置理由：必须先于「记录」与「准入」——被拦截的消息不写对话记录、
 * 不占并发名额、不碰 DSH 进程，就像它没来过；同时必须在命令路由之后，
 * 否则管理员在峰时段无法发 /offpeak off 关闸。
 *
 * 与 dispatcher 解耦的关键：判定配置来自 OffpeakGate 服务（env 默认 +
 * 运行期覆盖，下一条消息即生效），本 stage 只做"拦截并回复"这一件事。
 */
/**
 * Ingress stage ③：谷时段闸（DeepSeek 错峰优惠时段之外直接拒答，不调 API）。
 *
 * 位置理由：必须先于「记录」与「准入」——被拦截的消息不写对话记录、
 * 不占并发名额、不碰 DSH 进程，就像它没来过；同时必须在命令路由之后，
 * 否则管理员在峰时段无法发 /offpeak off 关闸。
 *
 * 与 dispatcher 解耦的关键：判定配置来自 OffpeakGate 服务（env 默认 +
 * 运行期覆盖，下一条消息即生效），本 stage 只做"拦截并回复"这一件事。
 */
import type { Config } from '../../config.js';
import type { OffpeakGate } from '../../offpeak/index.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';
export type createOffpeakGateStage = (deps: {
  gate: OffpeakGate;
  config: Config;
  stats: PipelineStats;
  now?: () => number;
}) => IngressStage;
