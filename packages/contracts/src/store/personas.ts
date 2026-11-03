/**
 * 预设风格前台（/persona 命令的存储与落盘层）。
 *
 * 形态：每会话可切换的人设预设 = 预设目录里的一个 `<名>.md` 文件。切换时把
 * 预设内容写进该会话工作区 `AGENTS.md` 的**标记区块**里：
 *
 *   <!-- qqbot-persona:begin name="concise" -->
 *   （此区块由 /persona 命令维护，区块之外的手写内容不受影响）
 *   ...预设内容...
 *   <!-- qqbot-persona:end -->
 *
 * 为什么是 AGENTS.md 而不是换 DSH 实例 / 换 profile patch：
 *   - `dsh-agent-instructions` 会在每个 step 前探测工作区指令文件的版本变化
 *     （mtime），外部改写在**下一个 turn 就会被拾起**——切换无需重建 runtime，
 *     也不丢会话记忆（已核对 DSH 源码：compose 于 agent/pre-step 对每个
 *     baseline scope 做版本探测，见 packages/context/agent-instructions）；
 *   - 管理员手写内容放在标记区块**之外**，切换只覆盖区块内，互补不互斥。
 *
 * 选择持久化到 `stateDir/personas.json`（原子写）：桥接进程重启后
 * `restoreAll()` 把每个会话的区块**幂等重写**一遍——正常工作区目录持久，
 * 这是防"工作区被手工清掉但选择还在"的兜底。
 *
 * 预设文件的信任边界：它们是**部署者**的内容（进的是 system 级上下文），
 * 所以只从配置的目录读、名字强制 `[a-z0-9-]`、体积封顶——群里任何人（包括
 * 管理员）都不能通过命令注入预设内容本身。
 */
/**
 * 预设风格前台（/persona 命令的存储与落盘层）。
 *
 * 形态：每会话可切换的人设预设 = 预设目录里的一个 `<名>.md` 文件。切换时把
 * 预设内容写进该会话工作区 `AGENTS.md` 的**标记区块**里：
 *
 *   <!-- qqbot-persona:begin name="concise" -->
 *   （此区块由 /persona 命令维护，区块之外的手写内容不受影响）
 *   ...预设内容...
 *   <!-- qqbot-persona:end -->
 *
 * 为什么是 AGENTS.md 而不是换 DSH 实例 / 换 profile patch：
 *   - `dsh-agent-instructions` 会在每个 step 前探测工作区指令文件的版本变化
 *     （mtime），外部改写在**下一个 turn 就会被拾起**——切换无需重建 runtime，
 *     也不丢会话记忆（已核对 DSH 源码：compose 于 agent/pre-step 对每个
 *     baseline scope 做版本探测，见 packages/context/agent-instructions）；
 *   - 管理员手写内容放在标记区块**之外**，切换只覆盖区块内，互补不互斥。
 *
 * 选择持久化到 `stateDir/personas.json`（原子写）：桥接进程重启后
 * `restoreAll()` 把每个会话的区块**幂等重写**一遍——正常工作区目录持久，
 * 这是防"工作区被手工清掉但选择还在"的兜底。
 *
 * 预设文件的信任边界：它们是**部署者**的内容（进的是 system 级上下文），
 * 所以只从配置的目录读、名字强制 `[a-z0-9-]`、体积封顶——群里任何人（包括
 * 管理员）都不能通过命令注入预设内容本身。
 */
import type { ContractFailure } from '@qqbot/contracts';
import type { Logger } from '../logger.js';
import type { StorePaths } from './paths.js';
/** 预设名：小写字母/数字/中划线。这条正则同时是路径穿越的防线。 */
export const PRESET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 单个预设的体积上限（字节）。人设是每轮都要付 token 的，不该是一篇文章。 */
export const MAX_PRESET_BYTES = 16 * 1024;
export interface PersonaApplyOk {
  ok: true;
  name: string;
}
export interface PersonaApplyFail {
  ok: false;
  reason: 'invalid-name' | 'unknown-preset' | 'empty-preset' | 'preset-too-large' | 'io';
  detail: string;
  /** 内部根因关联；既有命令仍按 reason/detail 显示降级说明。 */
  error?: ContractFailure;
}
export type PersonaApplyResult = PersonaApplyOk | PersonaApplyFail;
export interface PersonaStoreOptions {
  /** 预设目录（`personas.dir` / BOT_PERSONA_DIR，默认 dsh-profile/personas） */
  dir: string;
  /** 选择持久化文件（stateDir 下） */
  persistPath: string;
  paths: StorePaths;
  logger: Logger;
  /** 注入选择记录的原子写能力，便于离线写入故障验证。 */
  persistSelection?: (file: string, text: string) => void;
}
export interface PersonaStore {
  /** 预设目录下当前可用的预设名（每次现读目录：运维加文件即生效，不用重启）。 */
  listPresets(): string[];
  /** 该会话当前选择的预设名（未选 = undefined，即全局默认人设）。 */
  current(conversationKey: string): string | undefined;
  /**
   * 切换会话人设：把预设写进工作区 AGENTS.md 的标记区块，并持久化选择。
   * 成功即生效（下一个 turn 由 dsh-agent-instructions 拾起），不动 runtime。
   */
  apply(conversationKey: string, name: string): PersonaApplyResult;
  /** 恢复全局默认人设：移除标记区块（保留区块外手写内容）+ 清除选择。 */
  clear(conversationKey: string): {
    hadSelection: boolean;
  };
  /**
   * 启动期回放：把每个已选会话的区块**幂等重写**。
   * 预设文件已消失的会话：告警并丢弃选择（人设悄悄回默认比启动失败好）。
   */
  restoreAll(): void;
}
export type createPersonaStoreFactory = (options: PersonaStoreOptions) => PersonaStore;
