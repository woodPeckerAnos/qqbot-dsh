/**
 * 进群 / 加好友欢迎（系统事件分支，不走 Ingress 管线）。
 *
 * 欢迎语是主动下发的单条消息，没有配额账本语义（官方平台必须用
 * event_id 回复，与 msg_id 互斥；无此概念的平台忽略 eventId），
 * 所以直接经 BotConnector.reply 发出，只计 repliesSent。
 */

import type { BotConnector, NormalizedEvent } from '../../core/connector.js';
import type { Logger } from '../../logger.js';
import type { PipelineStats } from '../stats.js';

export async function handleWelcomeEvent(
  event: NormalizedEvent,
  deps: {
    connectors: ReadonlyMap<string, BotConnector>;
    stats: PipelineStats;
    logger: Logger;
  },
): Promise<void> {
  if (event.kind !== 'group-add-robot' && event.kind !== 'c2c-friend-add') return;
  const target = event.target;
  if (target === undefined) return;
  const connector = deps.connectors.get(target.platform);
  if (connector === undefined) {
    deps.logger.warn('收到未知平台的事件，已丢弃', {
      platform: target.platform,
      conversation: target.key,
    });
    return;
  }
  if (target.kind === 'c2c' && !connector.acceptsC2C) return;

  const text =
    target.kind === 'c2c'
      ? '我是运行在 Docker 里的 DSH 助手。直接给我发消息说明需求即可。'
      : '我是运行在 Docker 里的 DSH 助手。在群里 @我 并说明需求即可。';
  deps.logger.info(target.kind === 'c2c' ? '用户添加好友，发送欢迎语' : '机器人进群，发送欢迎语', {
    conversation: target.key,
    platform: target.platform,
  });
  try {
    // 官方平台回复进群/加好友事件必须用 event_id（与 msg_id 互斥）；
    // 无此概念的平台会忽略 eventId，直接当作普通消息发出。
    await connector.reply(
      {
        target,
        seq: 1,
        kind: 'final',
        ...(event.eventId !== undefined && event.eventId !== '' ? { eventId: event.eventId } : {}),
      },
      { text },
    );
    deps.stats.repliesSent += 1;
  } catch (error) {
    deps.logger.warn('发送欢迎语失败（不影响主要功能）', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
