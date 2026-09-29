/**
 * 健康检查与轻量指标。
 *
 * `/healthz`：给容器 HEALTHCHECK 与外部探活用。**是否 healthy 的判据是
 * "至少一个接入连接器已建立事件通道"**——一个看着活着但收不到消息的机器人
 * 在监控上必须表现为不健康，否则它静静躺几天都没人发现。
 * 多接入场景下某个连接器断开只产生 warning（服务降级），全部断开才不健康。
 *
 * `/metrics`：JSON 形式的计数器，比 Prometheus 文本格式更省事，也够用。
 *
 * 只监听 localhost 与容器网络，不对外暴露（compose 里未映射端口，
 * 容器内探针直接访问 localhost）。
 */

import { createServer, type Server } from 'node:http';

import type { ConnectorHealth } from './core/connector.js';
import type { Logger } from './logger.js';
import type { BackgroundSnapshot } from './pipeline/egress/background.js';
import type { PipelineStatsSnapshot } from './pipeline/stats.js';

export interface HealthSnapshot {
  ok: boolean;
  uptimeMs: number;
  /** 平台标识 → 该连接器的健康状态 */
  connectors: Record<string, ConnectorHealth & { staleMs?: number }>;
  runtime: { size: number; activeConversationKeys: string[]; activeSubagents: number };
  /** 后台任务投递状态：待带出结果的会话数与总条数（见 DESIGN §13.5） */
  background: BackgroundSnapshot;
  /** 编排层统计（字段名 dispatcher 是 /metrics 的对外契约，RUNBOOK 在用） */
  dispatcher: PipelineStatsSnapshot;
  /** 最近一次收到任何连接器事件的时间距今毫秒；undefined 表示还没收到过 */
  lastEventAgeMs?: number;
  warnings: string[];
}

export interface HealthServerOptions {
  port: number;
  logger: Logger;
  snapshot: () => HealthSnapshot;
}

export interface HealthServer {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  /** 当前实际监听端口（0 表示随机端口时有用） */
  address(): { port: number } | undefined;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  let server: Server | undefined;

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/healthz' || url === '/health') {
      const snapshot = options.snapshot();
      const status = snapshot.ok ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify(snapshot, null, 2)}\n`);
      return;
    }
    if (url === '/metrics') {
      const snapshot = options.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        `${JSON.stringify(
          {
            uptimeMs: snapshot.uptimeMs,
            connectors: snapshot.connectors,
            runtime: snapshot.runtime,
            background: snapshot.background,
            dispatcher: snapshot.dispatcher,
            lastEventAgeMs: snapshot.lastEventAgeMs,
            warnings: snapshot.warnings,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  };

  return {
    async start() {
      server = createServer((req, res) => {
        try {
          handler(req, res);
        } catch (error) {
          options.logger.error('health 处理请求失败', {
            error: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(500);
          res.end('internal error\n');
        }
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(options.port, '0.0.0.0', () => resolve());
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      options.logger.info('健康检查服务已启动', { port, endpoints: ['/healthz', '/metrics'] });
      return { port };
    },
    async stop() {
      const current = server;
      server = undefined;
      if (current === undefined) return;
      await new Promise<void>((resolve) => current.close(() => resolve()));
    },
    address() {
      const address = server?.address();
      if (typeof address === 'object' && address !== null) return { port: address.port };
      return undefined;
    },
  };
}

/**
 * 判定事件通道是否"看着连着但其实死了"。
 *
 * 官方网关心跳周期通常 45 秒，OneBot 框架侧心跳一般 5~60 秒；
 * 取 150 秒作为统一的陈旧阈值：超过它没有任何事件，即使连接还在
 * 也应该告警（多接入时只告警不判死，单接入时配合 connected=false 判不健康）。
 */
export const EVENT_STALE_THRESHOLD_MS = 150_000;

export function buildHealthSnapshot(input: {
  startedAt: number;
  connectors: Record<string, ConnectorHealth>;
  runtime: { size: number; activeConversationKeys: string[]; activeSubagents: number };
  background: BackgroundSnapshot;
  dispatcher: PipelineStatsSnapshot;
  now?: number;
}): HealthSnapshot {
  const now = input.now ?? Date.now();
  const warnings: string[] = [];
  const connectors: Record<string, ConnectorHealth & { staleMs?: number }> = {};

  let anyConnected = false;
  let lastEventAt: number | undefined;

  for (const [name, connector] of Object.entries(input.connectors)) {
    if (connector.connected) anyConnected = true;
    else warnings.push(`连接器 ${name} 未建立事件通道（state=${connector.state}）`);

    if (connector.lastEventAt !== undefined) {
      if (lastEventAt === undefined || connector.lastEventAt > lastEventAt) {
        lastEventAt = connector.lastEventAt;
      }
      const staleMs = now - connector.lastEventAt;
      if (connector.connected && staleMs > EVENT_STALE_THRESHOLD_MS) {
        warnings.push(
          `连接器 ${name} 超过 ${Math.round(EVENT_STALE_THRESHOLD_MS / 1000)} 秒未收到事件` +
            `（${Math.round(staleMs / 1000)}s），通道可能已僵死`,
        );
      }
    }
    if ((connector.reconnectAttempts ?? 0) > 5) {
      warnings.push(`连接器 ${name} 重连次数偏多（${connector.reconnectAttempts}），请检查凭据与订阅配置`);
    }
    for (const warning of connector.warnings ?? []) {
      warnings.push(`${name}: ${warning}`);
    }
    connectors[name] = {
      ...connector,
      ...(connector.lastEventAt !== undefined ? { staleMs: now - connector.lastEventAt } : {}),
    };
  }

  // 就绪判据：至少一个连接器已建立事件通道。其余项只产生 warning，不改变 ok。
  // 这样"进程活着但一个事件来源都没有"会被如实报告为不健康。
  const ok = anyConnected;

  return {
    ok,
    uptimeMs: now - input.startedAt,
    connectors,
    runtime: input.runtime,
    background: input.background,
    dispatcher: input.dispatcher,
    ...(lastEventAt !== undefined ? { lastEventAgeMs: now - lastEventAt } : {}),
    warnings,
  };
}
