/**
 * 把一轮 turn 的耗时拆成「模型步进」与「工具执行」，用于回答
 * "到底是模型慢、工具慢，还是模型在原地打转"。
 *
 * 数据源是 DSH 自己的会话日志：
 *   $DSH_HOME/sessions/<工作区 mangled>/session-<id>/session.v<N>.jsonl[.zstd]
 *
 * 为什么不直接看 bot 日志：bot 日志只有"已派发 prompt / 本轮超时"两个端点，
 * 中间每一步花了多久只有会话日志里有（step/start、assistant/message、
 * tool/call、tool/result、step/end 都带毫秒时间戳）。
 *
 * 用法（容器内）：
 *   docker compose cp scripts/analyze-turn-timing.mjs qqbot:/tmp/
 *   docker compose exec -T qqbot node /tmp/analyze-turn-timing.mjs \
 *     /data/dsh/sessions/<ws>/session-<id>/session.v4.jsonl.zstd
 *
 * 也可以一次给多个文件。zstd 是按追加帧写的，Node 的 zstdDecompressSync
 * 只认第一帧，所以这里按魔数切帧逐帧解压——不依赖容器里装 zstd。
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = [
  [0x28, 0xb5, 0x2f, 0xfd],
  // skippable frame（0x184D2A50–0x184D2A5F），正常不会出现，遇到就跳过
  [0x50, 0x2a, 0x4d, 0x18],
].map((bytes) => Buffer.from(bytes));

const argv = process.argv.slice(2);
const files = [];
let showPrompt = false;
let promptChars = 800;
for (const arg of argv) {
  if (arg === '--prompt') showPrompt = true;
  else if (arg.startsWith('--prompt=')) {
    showPrompt = true;
    promptChars = Number(arg.slice('--prompt='.length)) || promptChars;
  } else if (arg === '-h' || arg === '--help') {
    files.length = 0;
    break;
  } else if (!arg.startsWith('-')) files.push(arg);
}

if (files.length === 0) {
  console.error(
    [
      '用法: node analyze-turn-timing.mjs [--prompt[=字符数]] <session.v*.jsonl[.zstd]> [更多文件…]',
      '',
      '输出: 每轮 turn 的总时长、reason、步数、模型耗时/工具耗时占比；',
      '      每个 step 的 model / tool / prompt token / output token；',
      '      本轮工具分布与最慢的工具调用（带 [超时] 标记）。',
      '--prompt: 额外打印每轮第一条用户消息（看提示词/长任务提示是否注入）。',
      '',
      '找文件: ls -lt /data/dsh/sessions/*/*/session.v*.jsonl* | head',
    ].join('\n'),
  );
  process.exit(2);
}

/**
 * 按 zstd 帧魔数切分并逐帧解压。非 zstd 文件原样返回。
 * 扫描魔数可能撞上压缩数据里的假阳性：解不开的帧直接丢弃，不影响其余帧。
 */
function decode(filePath) {
  const buf = readFileSync(filePath);
  if (!filePath.endsWith('.zstd')) return buf.toString('utf8');

  const starts = [];
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (ZSTD_MAGIC.some((m) => buf[i] === m[0] && buf[i + 1] === m[1] && buf[i + 2] === m[2] && buf[i + 3] === m[3])) {
      starts.push(i);
    }
  }
  if (starts.length === 0) throw new Error('不是 zstd 流（找不到帧魔数）');

  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[k], end)));
    } catch {
      // 假阳性或截断的半帧：丢掉，继续解后面的
    }
  }
  if (parts.length === 0) throw new Error('zstd 帧全部解压失败（文件可能被截断）');
  return Buffer.concat(parts).toString('utf8');
}

function parseEvents(text) {
  const events = [];
  let corrupted = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') events.push(parsed);
    } catch {
      corrupted += 1;
    }
  }
  return { events, corrupted };
}

function textOfToolResult(result) {
  const content = result?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** 从事件流里还原 turn / step / 工具调用。 */
function analyze(events) {
  const turns = [];
  let turn;
  let step;
  let pendingCalls = [];

  const closeStep = (endTime) => {
    if (step === undefined) return;
    step.end = endTime ?? step.lastTime ?? step.start;
    step.total = step.end - step.start;
    if (turn !== undefined) turn.steps.push(step);
    step = undefined;
    pendingCalls = [];
  };

  for (const event of events) {
    const time = typeof event.time === 'number' ? event.time : undefined;
    const data = event.data ?? {};

    if (event.type === 'turn/start') {
      if (turn !== undefined) turns.push(turn); // 上一轮没写 turn/end，按未结束保留
      turn = { n: data.turn, start: time, steps: [], reason: '未结束', unfinished: true, promptText: undefined, imageBlocks: 0 };
      continue;
    }
    if (event.type === 'step/start') {
      if (turn === undefined) continue;
      step = { n: data.step, start: time, model: undefined, usage: undefined, tools: [], lastTime: time };
      continue;
    }
    if (event.type === 'user/message') {
      const content = data.content;
      if (turn !== undefined && Array.isArray(content)) {
        const images = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'image').length;
        if (images > 0) turn.imageBlocks += images;
        if (turn.promptText === undefined) {
          turn.promptText = content
            .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
        }
      }
      continue;
    }
    if (event.type === 'assistant/message') {
      if (step !== undefined && time !== undefined) {
        step.model ??= time - step.start;
        step.usage = data.usage ?? step.usage;
        step.lastTime = time;
      }
      continue;
    }
    if (event.type === 'tool/call') {
      if (step !== undefined && time !== undefined) {
        pendingCalls.push({ name: typeof data.name === 'string' ? data.name : '?', start: time });
        step.lastTime = time;
      }
      continue;
    }
    if (event.type === 'tool/result') {
      if (step !== undefined && time !== undefined) {
        const call = pendingCalls.shift();
        if (call !== undefined) {
          const text = textOfToolResult(event);
          step.tools.push({
            name: call.name,
            ms: time - call.start,
            timedOut: /timed out after|tool call timed out/i.test(text),
          });
        }
        step.lastTime = time;
      }
      continue;
    }
    if (event.type === 'step/end') {
      if (step !== undefined && time !== undefined) step.lastTime = time;
      closeStep(time);
      continue;
    }
    if (event.type === 'turn/end') {
      if (step !== undefined) closeStep(time);
      if (turn !== undefined) {
        turn.end = time;
        turn.reason = data.reason?.kind ?? '?';
        turn.unfinished = false;
        turns.push(turn);
        turn = undefined;
      }
    }
  }

  if (step !== undefined) closeStep(undefined);
  if (turn !== undefined) {
    turn.end = turn.steps.at(-1)?.end ?? turn.start;
    turns.push(turn);
  }
  return turns;
}

function fmtMs(ms) {
  if (ms === undefined) return '?';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function render(filePath, events, corrupted) {
  const header = events.find((event) => event.type === 'session');
  const turns = analyze(events);

  console.log(`\n=== ${filePath}`);
  console.log(
    `    session=${header?.id ?? '?'}  cwd=${header?.cwd ?? '?'}  events=${events.length}` +
      (corrupted > 0 ? `  行解析失败=${corrupted}` : ''),
  );
  if (turns.length === 0) {
    console.log('    没有 turn/start：这个会话还没跑过一轮，或日志被截断。');
    return;
  }

  for (const turn of turns) {
    const modelMs = turn.steps.reduce((sum, s) => sum + (s.model ?? 0), 0);
    const toolMs = turn.steps.reduce((sum, s) => sum + s.tools.reduce((t, x) => t + x.ms, 0), 0);
    const promptPeak = Math.max(0, ...turn.steps.map((s) => (s.usage?.inputTokens ?? 0) + (s.usage?.cacheReadTokens ?? 0)));
    const output = turn.steps.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);
    const steps = turn.steps.length;
    const totalMs = turn.end - turn.start;

    console.log(
      `\n  turn ${turn.n}  ${fmtMs(totalMs)}  ${turn.reason}` +
        `${turn.unfinished ? '（没有 turn/end：进程被杀或仍在跑）' : ''}` +
        `  ·  ${steps} 步  ·  模型 ${fmtMs(modelMs)} (${pct(modelMs, totalMs)})` +
        `  工具 ${fmtMs(toolMs)} (${pct(toolMs, totalMs)})` +
        `  ·  prompt 峰值 ${promptPeak}  output 合计 ${output}` +
        (turn.imageBlocks > 0 ? `  ·  附图 ${turn.imageBlocks}` : ''),
    );

    for (const s of turn.steps) {
      const tool = s.tools.reduce((sum, x) => sum + x.ms, 0);
      const prompt = (s.usage?.inputTokens ?? 0) + (s.usage?.cacheReadTokens ?? 0);
      console.log(
        `    step ${String(s.n ?? '?').padStart(2)}` +
          `  model ${fmtMs(s.model).padStart(7)}` +
          `  tool ${fmtMs(tool).padStart(7)}` +
          `  step ${fmtMs(s.total).padStart(7)}` +
          `  prompt ${String(prompt).padStart(6)}` +
          `  out ${String(s.usage?.outputTokens ?? '?').padStart(5)}`,
      );
    }

    if (showPrompt && typeof turn.promptText === 'string' && turn.promptText.trim() !== '') {
      const text = turn.promptText.replace(/\s+/g, ' ').trim();
      const truncated = text.length > promptChars ? `${text.slice(0, promptChars)}…` : text;
      const hint = /后台|subagent|耗时长|长任务/.test(turn.promptText) ? ' [含后台/长任务提示]' : '';
      console.log(`    prompt${hint}${turn.imageBlocks > 0 ? `（附图 ${turn.imageBlocks} 块）` : ''}: ${truncated}`);
    }

    const allTools = turn.steps.flatMap((s) => s.tools);
    if (allTools.length > 0) {
      const counts = new Map();
      for (const tool of allTools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      const dist = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, n]) => `${name}×${n}`)
        .join(' · ');
      console.log(`    工具分布: ${dist}`);
    }

    const slowTools = turn.steps
      .flatMap((s) => s.tools)
      .filter((tool) => tool.ms >= 3_000 || tool.timedOut)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
    if (slowTools.length > 0) {
      console.log(
        `    慢工具: ${slowTools.map((tool) => `${tool.name} ${fmtMs(tool.ms)}${tool.timedOut ? ' [超时]' : ''}`).join(' · ')}`,
      );
    }
    const timeouts = turn.steps.flatMap((s) => s.tools).filter((tool) => tool.timedOut).length;
    if (timeouts > 0) console.log(`    ⚠ 本轮有 ${timeouts} 次工具超时（bash 默认 60s，可显式传 timeoutMs 放宽到 600s；见 docs/LATENCY-TRIAGE.md）`);
  }
}

function pct(part, total) {
  if (!Number.isFinite(total) || total <= 0) return '?%';
  return `${Math.round((part / total) * 100)}%`;
}

for (const filePath of files) {
  try {
    const text = decode(filePath);
    const { events, corrupted } = parseEvents(text);
    render(filePath, events, corrupted);
  } catch (error) {
    console.error(`\n=== ${filePath}\n    读取失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
