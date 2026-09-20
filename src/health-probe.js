/**
 * 容器 HEALTHCHECK 用的轻量探针（编译产物为 dist/health-probe.js）。
 *
 * Docker 的 HEALTHCHECK 每次都会新起一个进程，所以这里刻意写得极简：
 * 只发一个 HTTP 请求、按 states 决定退出码，不加载任何业务模块。
 *
 * 用法：node dist/health-probe.js [port]
 *   退出码 0 = 健康；1 = 不健康或请求失败。
 */

const port = Number(process.argv[2] ?? process.env.QQ_HEALTH_PORT ?? 8080);

const timeout = setTimeout(() => {
  process.stderr.write('health-probe: 请求超时\n');
  process.exit(1);
}, 4_000);
timeout.unref?.();

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await response.text();
  clearTimeout(timeout);
  if (response.ok) {
    process.exit(0);
  }
  process.stderr.write(`health-probe: 不健康（HTTP ${response.status}）\n${body}\n`);
  process.exit(1);
} catch (error) {
  clearTimeout(timeout);
  process.stderr.write(
    `health-probe: 无法连接健康检查端口 ${port}：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
