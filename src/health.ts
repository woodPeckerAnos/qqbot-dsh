/**
 * 健康检查与轻量指标。
 *
 * `/healthz`：给容器 HEALTHCHECK 与外部探活用。**是否 healthy 的判据是
 * "QQ 网关已连接"**——一个连着但收不到事件的机器人在监控上必须表现为不健康，
 * 否则它静静躺几天都没人发现。
 *
 * `/metrics`：JSON 形式的计数器，比 Prometheus 文本格式更省事，也够用。
 *
 * 只监听 localhost 与容器网络，不对外暴露（compose 里未映射端口，
 * 容器内探针直接访问 localhost）。
 */

import { createServer, type Server } from 'node:http';

import type { Logger } from './logger.js';
import type { EventSourceHealth } from './qq/gateway.js';
import type { DispatcherStats } from './pipeline/dispatcher.js';

export interface HealthSnapshot {
  ok: boolean;
  uptimeMs: number;
  gateway: EventSourceHealth & { staleMs?: number };
  runtime: { size: number; activeGroupKeys: string[] };
  dispatcher: DispatcherStats & { inFlight: number; queued: number };
  token: { hasToken: boolean; expiresInMs: number };
  /** 最近一次收到网关事件的时间距今毫秒；undefined 表示还没收到过 */
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
            gateway: snapshot.gateway,
            runtime: snapshot.runtime,
            dispatcher: snapshot.dispatcher,
            token: snapshot.token,
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
 * 判定网关是否"看着连着但其实死了"。
 *
 * 官方心跳周期通常 45 秒，取 3 倍作为陈旧阈值：超过它没有任何事件，
 * 即使 TCP 还连着也应该判不健康（触发容器重启或告警）。
 */
export const GATEWAY_STALE_THRESHOLD_MS = 150_000;

export function buildHealthSnapshot(input: {
  startedAt: number;
  gateway: EventSourceHealth;
  runtime: { size: number; activeGroupKeys: string[] };
  dispatcher: DispatcherStats & { inFlight: number; queued: number };
  token: { hasToken: boolean; expiresInMs: number };
  now?: number;
}): HealthSnapshot {
  const now = input.now ?? Date.now();
  const lastEventAt = input.gateway.lastEventAt;
  const lastEventAgeMs = lastEventAt === undefined ? undefined : now - lastEventAt;

  const warnings: string[] = [];
  const gateway = input.gateway;

  if (!gateway.connected) {
    warnings.push(`QQ 网关未连接（state=${gateway.state}）`);
  }
  if (lastEventAgeMs !== undefined && lastEventAgeMs > GATEWAY_STALE_THRESHOLD_MS) {
    warnings.push(
      `超过 ${Math.round(GATEWAY_STALE_THRESHOLD_MS / 1000)} 秒未收到网关事件（${Math.round(
        lastEventAgeMs / 1000,
      )}s），连接可能已僵死`,
    );
  }
  if (gateway.reconnectAttempts > 5) {
    warnings.push(`重连次数偏多（${gateway.reconnectAttempts}），请检查 AppID/Secret 与 intent 配置`);
  }
  if (!input.token.hasToken) {
    warnings.push('尚未取得 access_token');
  }

  // 就绪判据：网关已连接。其余项只产生 warning，不改变 ok。
  // 这样"进程活着但连不上 QQ"会被如实报告为不健康。
  const ok = gateway.connected;

  return {
    ok,
    uptimeMs: now - input.startedAt,
    gateway: { ...gateway, ...(lastEventAgeMs !== undefined ? { staleMs: lastEventAgeMs } : {}) },
    runtime: input.runtime,
    dispatcher: input.dispatcher,
    token: input.token,
    ...(lastEventAgeMs !== undefined ? { lastEventAgeMs } : {}),
    warnings,
  };
}
