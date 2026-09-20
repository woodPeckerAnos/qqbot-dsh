/**
 * 容器内沙箱能力自检。
 *
 * 这是 A 方案（workspace-write + 自动审批桩）能否真正成立的地基。
 *
 * 为什么必须单独检测：实测发现（见 docs/DESIGN.md 6.2），当宿主没有可用的沙箱
 * 后端时，DSH 在 workspace-write 下连 `cat` 都跑不了，会主动请求提权到
 * danger-full-access；审批桩放行后**实际权限就等于完全访问**，
 * 于是 workspace-write 只是一句口号。
 *
 * DSH 在 Linux 上的后端链是 ["bwrap", "landlock"]，两者都声明 full 保真：
 *   - bwrap（bubblewrap）：需要内核允许非特权 user namespace（容器里常被限制）；
 *   - landlock：需要内核 >= 5.13 且 LSM 已启用（容器里通常可用）。
 * 二者都被探测为不可用时，workspace-write 就会退化。
 *
 * 用法（容器内）：
 *   node scripts/verify-sandbox-capability.mjs
 *   退出码 0 = 至少一个后端可用；3 = 都不可用（会打印修复建议）
 */

import { spawnSync } from 'node:child_process';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// 1. 内核与 user namespace 现状
// ---------------------------------------------------------------------------

try {
  const uname = spawnSync('uname', ['-r'], { encoding: 'utf8' });
  console.log(`内核版本：${uname.stdout?.trim() ?? '未知'}`);
} catch {
  /* 非 Linux 或命令缺失 */
}

let usernsValue;
try {
  const { readFileSync } = await import('node:fs');
  usernsValue = readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
  console.log(`unprivileged_userns_clone = ${usernsValue}`);
} catch {
  usernsValue = undefined;
  console.log('unprivileged_userns_clone：文件不存在（较新内核已移除该开关，通常表示允许）');
}

// ---------------------------------------------------------------------------
// 2. bubblewrap 后端
// ---------------------------------------------------------------------------

const bwrapPresent = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
if (bwrapPresent.error !== undefined) {
  record('bubblewrap 已安装', false, '未找到 bwrap 可执行文件');
} else {
  record('bubblewrap 已安装', true, (bwrapPresent.stdout ?? '').trim());
  // 真正能创建 profile 才算可用：只用 --ro-bind + --unshare-pid 探一次
  const probe = spawnSync(
    'bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--', 'true'],
    { encoding: 'utf8', timeout: 5_000 },
  );
  const ok = probe.status === 0;
  record(
    'bubblewrap 能创建沙箱 profile',
    ok,
    ok
      ? '工作区内操作可由 bwrap 强制'
      : `退出码 ${probe.status ?? 'n/a'}：${(probe.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Landlock 后端
// ---------------------------------------------------------------------------

let landlockVerdict = 'unusable';
try {
  const mod = await import('@deepseek-ai/node-addon-system/landlock-run');
  landlockVerdict = mod.probe();
  record(
    'Landlock 内核强制可用',
    landlockVerdict !== 'unusable',
    `verdict=${landlockVerdict}`,
  );
} catch (error) {
  record('Landlock 内核强制可用', false, `无法加载探针：${error.message}`);
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

const bwrapOk = results.find((r) => r.name === 'bubblewrap 能创建沙箱 profile')?.ok === true;
const landlockOk = landlockVerdict !== 'unusable';
const effective = bwrapOk || landlockOk;

console.log('\n================ 结论 ================');
if (effective) {
  console.log(
    `VERDICT: SANDBOX-EFFECTIVE —— 可用后端：${[bwrapOk ? 'bwrap' : null, landlockOk ? `landlock(${landlockVerdict})` : null]
      .filter(Boolean)
      .join(', ')}`,
  );
  console.log('workspace-write 是一道真闸，A 方案成立。');
} else {
  console.log('VERDICT: DEGRADED —— 没有任何可用沙箱后端。');
  console.log('workspace-write 下 DSH 会请求提权到 danger-full-access，实际权限等于完全访问。');
  console.log('\n修复方向（任选其一）：');
  console.log('  1. 给容器加 --security-opt seccomp=unconfined 或放开非特权 user namespace；');
  console.log('  2. 确认宿主内核 >= 5.13 且未禁用 Landlock（lsm=...,landlock）；');
  console.log('  3. 若接受该降级，把 allowEscalation 保持 true 并依赖容器边界（只读根文件系统、');
  console.log('     cap_drop、资源上限）；');
  console.log('  4. 若不能接受，把 dsh-profile 里 allowEscalation 设为 false —— 提权会被拒绝，');
  console.log('     但机器人也将无法执行任何命令。');
}

if (usernsValue === '0' && !landlockOk) {
  console.log('\n提示：unprivileged_userns_clone=0 且 Landlock 不可用，这解释了 bwrap 失败。');
}

process.exit(effective ? 0 : 3);
