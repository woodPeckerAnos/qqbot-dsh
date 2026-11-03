import type { SessionActor } from '../../task/session-actor.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';
/** 整句匹配控制命令，兼容官方 @ 前缀；/reset 是 /new 的别名。 */
export type parseSessionCommand = (content: string) => 'stop' | 'new' | undefined;
export interface SessionCommandRouter {
  stage(): IngressStage;
}
export type createSessionCommandRouterFactory = (options: {
  actor: SessionActor;
  stats: PipelineStats;
}) => SessionCommandRouter;
