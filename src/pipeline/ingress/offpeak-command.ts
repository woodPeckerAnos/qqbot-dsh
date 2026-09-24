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
import {
  commandNeedsAdmin,
  evaluateGate,
  formatWindows,
  OffpeakConfigError,
  OFFPEAK_COMMAND_USAGE,
  parseOffpeakCommand,
  parseWindowsSpec,
  type OffpeakCommand,
  type OffpeakGate,
} from '../../offpeak.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage, MessageContext } from './types.js';

export class OffpeakCommandRouter {
  constructor(
    private readonly deps: {
      gate: OffpeakGate;
      config: Config;
      stats: PipelineStats;
      now?: () => number;
    },
  ) {}

  stage(): IngressStage {
    return async (ctx, next) => {
      const command = parseOffpeakCommand(ctx.message.content);
      if (command === undefined) {
        await next();
        return;
      }
      await this.handle(ctx, command);
    };
  }

  private async handle(ctx: MessageContext, command: OffpeakCommand): Promise<void> {
    const { message, logger, responder } = ctx;

    if (commandNeedsAdmin(command) && !ctx.isAdmin) {
      logger.warn('非管理员尝试变更谷时段闸，已拒绝', {
        senderId: message.senderId,
        platform: message.target.platform,
        action: command.action,
      });
      await responder
        .error('无权限：/offpeak 的变更操作仅限管理员（BOT_ADMINS 白名单）。')
        .catch(() => {});
      return;
    }

    this.deps.stats.adminCommands += 1;

    switch (command.action) {
      case 'whoami': {
        const idKind = message.target.kind === 'c2c' ? '单聊' : '群聊';
        await responder
          .error(
            `你的管理员身份键：${message.target.platform}:${message.senderId}` +
              `（${idKind}，平台 ${message.target.platform}）。` +
              '把它加进环境变量 BOT_ADMINS（逗号分隔）即可成为管理员。',
          )
          .catch(() => {});
        return;
      }
      case 'status': {
        await responder.error(this.renderStatus()).catch(() => {});
        return;
      }
      case 'set-enabled': {
        const effective = this.deps.gate.setEnabled(command.enabled, message.senderId);
        logger.warn('谷时段闸已被管理员热切换', {
          senderId: message.senderId,
          platform: message.target.platform,
          enabled: command.enabled,
        });
        await responder
          .error(
            `谷时段闸已${command.enabled ? '开启' : '关闭'}（运行期覆盖，重启后保留）。` +
              `当前窗口：${formatWindows(effective.windows)}（${effective.timeZone}）。`,
          )
          .catch(() => {});
        return;
      }
      case 'set-windows': {
        try {
          const windows = parseWindowsSpec(command.spec);
          const effective = this.deps.gate.setWindows(windows, message.senderId);
          logger.warn('谷时段窗口已被管理员热切换', {
            senderId: message.senderId,
            platform: message.target.platform,
            windows: command.spec,
          });
          await responder
            .error(
              `谷时段窗口已更新为 ${formatWindows(effective.windows)}（${effective.timeZone}，运行期覆盖）。`,
            )
            .catch(() => {});
        } catch (error) {
          const detail = error instanceof OffpeakConfigError ? error.message : '窗口参数无效';
          await responder.error(`设置失败：${detail}`).catch(() => {});
        }
        return;
      }
      case 'holiday-add':
      case 'holiday-del': {
        const adding = command.action === 'holiday-add';
        try {
          if (adding) {
            this.deps.gate.addHoliday(command.date, message.senderId);
          } else {
            this.deps.gate.delHoliday(command.date, message.senderId);
          }
          const snapshot = this.deps.gate.snapshot();
          logger.warn('谷时段节假日表已被管理员热更新', {
            senderId: message.senderId,
            platform: message.target.platform,
            action: command.action,
            date: command.date,
          });
          await responder
            .error(
              `已${adding ? '追加' : '移除'}全天谷价日期 ${command.date}（运行期覆盖）。` +
                `当前节假日表共 ${snapshot.holidaysCount} 天。`,
            )
            .catch(() => {});
        } catch (error) {
          const detail = error instanceof OffpeakConfigError ? error.message : '日期参数无效';
          await responder.error(`设置失败：${detail}`).catch(() => {});
        }
        return;
      }
      case 'holiday-list': {
        const holidays = [...this.deps.gate.effective().holidays].sort();
        const text =
          holidays.length === 0
            ? '节假日表为空。'
            : `全天谷价日期（${holidays.length} 天）：${holidays.join('、')}`;
        await responder.error(text).catch(() => {});
        return;
      }
      case 'reset': {
        this.deps.gate.clearOverride(message.senderId);
        logger.warn('谷时段闸覆盖已被管理员清除，恢复 env 默认', {
          senderId: message.senderId,
          platform: message.target.platform,
        });
        await responder.error(this.renderStatus()).catch(() => {});
        return;
      }
      case 'invalid': {
        await responder.error(`${command.detail}。${OFFPEAK_COMMAND_USAGE}`).catch(() => {});
        return;
      }
    }
  }

  /** 闸状态的纯文本描述（status 命令与 reset 后的回执共用）。 */
  private renderStatus(): string {
    const { gate, config } = this.deps;
    const snapshot = gate.snapshot();
    const decision = evaluateGate({
      config: gate.effective(),
      provider: config.dsh.provider,
      model: config.dsh.model,
      isAdmin: false,
      now: this.now(),
    });
    const reasonText: Record<string, string> = {
      weekend: '周末全天谷价',
      holiday: '法定节假日全天谷价',
      'in-window': '谷时段窗口内',
      'model-mismatch': '模型不匹配',
      disabled: '闸已关闭',
      admin: '管理员',
    };
    const lines = [
      `谷时段闸：${snapshot.enabled ? '开启' : '关闭'}${snapshot.overridden ? '（管理员覆盖）' : '（env 默认）'}`,
      `工作日窗口：${snapshot.windows.join('、')}（${snapshot.timeZone}）`,
      `周末全天谷价：${snapshot.weekendsAllDay ? '是' : '否'}；` +
        `节假日表 ${snapshot.holidaysCount} 天` +
        (snapshot.holidaysCoverageUntil !== undefined
          ? `（覆盖至 ${snapshot.holidaysCoverageUntil}，之后年份需管理员 /offpeak holiday add）`
          : ''),
      `模型匹配：${snapshot.modelPattern}；当前模型 ${config.dsh.provider}/${config.dsh.model}`,
      `当前判定：${decision.gated ? '拦截中（正价时段）' : `放行（${reasonText[decision.reason] ?? decision.reason}）`}`,
      OFFPEAK_COMMAND_USAGE,
    ];
    return lines.join('\n');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
