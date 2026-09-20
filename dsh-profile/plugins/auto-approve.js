/**
 * 无人值守审批桩（A 方案的核心组件）。
 *
 * 背景：`@deepseek-ai/dsh-user-approval` 在没有终端应答者时，任何 `ask` 都会
 * 落到 fail-closed 的 `unavailable`，于是 workspace-write 下 agent 每次想写
 * 文件、跑命令都会被拒绝——机器人等于废掉。本插件注册一个**终端应答者**，
 * 把审批请求判为 `allowed-once`。
 *
 * 为什么保留 `ask` 而不是直接 `policy: never`：
 *   - `ask` + 本桩 → 沙箱模式仍是 `workspace-write`，工作区之外仍被沙箱挡住；
 *   - `never` → 审批全拒，工具调用直接失败。
 * 所以本桩只是"自动按下同意按钮"，本身不改变沙箱边界。
 *
 * ⚠ 两种审批请求必须区分对待（实测发现）：
 *   1. 普通审批：例如工具要写工作区内的文件。放行即可。
 *   2. **沙箱提权**（reason 里含 "escalate sandbox"）：当宿主缺少可用的沙箱
 *      后端时（例如 macOS 没有 sandbox-exec、Linux 容器里没装 bubblewrap），
 *      workspace-write 下 bash 连 `cat` 都跑不了，DSH 会请求提权到
 *      danger-full-access。此刻放行意味着**实际权限变成完全访问**，
 *      workspace-write 这道闸等于不存在。
 *   allowEscalation 默认 true（否则在无沙箱后端的宿主上机器人直接不可用），
 *   但每次提权都会以 `warn` 级别打日志，并在启动时由 health 模块检查后端可用性。
 *   想收紧就设成 false，此时提权被拒（fail closed），机器人只能做不需要执行
 *   命令的工作。
 *
 * 真正的安全边界因此落在容器上：只读根文件系统、cap_drop、资源上限、出网白名单。
 * 详见 docs/DESIGN.md 第 6 节。
 *
 * 该文件以相对路径被 cordis.patch.yml 引用（dsh-app-boot 会把相对 name 解析成
 * 相对 patch 文件的 file:// URL），因此不需要装进 profile 的 node_modules。
 */

/** 与 @deepseek-ai/dsh-user-approval 的 OUTCOMES 词表一致。 */
const GRANT = 'allowed-once';
const REJECT = 'rejected';

export const name = 'qqbot-auto-approve';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{allowTools?: string[], denyTools?: string[], allowEscalation?: boolean}} config
 */
export function apply(ctx, config = {}) {
  const deny = new Set(config.denyTools ?? []);
  const allow = config.allowTools === undefined ? undefined : new Set(config.allowTools);
  const allowEscalation = config.allowEscalation !== false;

  const log = (level, message, extra) => {
    // DSH 的 stdout 是 JSON-RPC 专用通道，任何日志只能走 stderr。
    process.stderr.write(
      `${JSON.stringify({ level, time: Date.now(), plugin: name, message, ...extra })}\n`,
    );
  };

  ctx.on('approval/request', (request, next) => {
    const toolName = request?.toolName ?? 'unknown';
    const reason = request?.reason ?? '';
    const isEscalation = reason.includes('escalate sandbox');

    if (deny.has(toolName)) return next();
    if (allow !== undefined && !allow.has(toolName)) return next();

    if (isEscalation && !allowEscalation) {
      log('warn', 'sandbox escalation denied', { toolName, reason });
      return REJECT;
    }

    log(isEscalation ? 'warn' : 'info', isEscalation ? 'sandbox escalation auto-approved' : 'auto-approved', {
      toolName,
      callId: request?.callId,
      reason,
      sessionId: request?.agent?.session?.id,
    });
    return GRANT;
  });

  log('info', 'plugin mounted', {
    deny: [...deny],
    allow: allow ? [...allow] : null,
    allowEscalation,
  });
}
