import { PRESET_NAME_RE, MAX_PRESET_BYTES } from '@qqbot/contracts';
import type { PersonaApplyFail, PersonaApplyResult, PersonaStoreOptions } from '@qqbot/contracts';
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { failure, readonlySnapshot } from '@qqbot/contracts';

import { ensureWorkspace, workspacePathFor } from './paths.js';

/** 预设名：小写字母/数字/中划线。这条正则同时是路径穿越的防线。 */
export { PRESET_NAME_RE } from '@qqbot/contracts';

/** 单个预设的体积上限（字节）。人设是每轮都要付 token 的，不该是一篇文章。 */
export { MAX_PRESET_BYTES } from '@qqbot/contracts';

const BLOCK_END = '<!-- qqbot-persona:end -->';
/** 整个区块（含前后至多一个换行），替换/清除用。 */
const BLOCK_RE = /\n?<!-- qqbot-persona:begin[^>]*-->[\s\S]*?<!-- qqbot-persona:end -->\n?/;

/** 工作区里写人设区块的目标文件名（dsh-agent-instructions 自动加载它）。 */
const AGENTS_FILE = 'AGENTS.md';

export type { PersonaApplyOk } from '@qqbot/contracts';
export type { PersonaApplyFail } from '@qqbot/contracts';
export type { PersonaApplyResult } from '@qqbot/contracts';

interface PersistShape {
  version: 1;
  personas: Record<string, string>;
}

export type { PersonaStoreOptions } from '@qqbot/contracts';

export class PersonaStore {
  private readonly options: PersonaStoreOptions;
  private readonly selections = new Map<string, string>();

  constructor(options: PersonaStoreOptions) {
    this.options = { ...options, paths: readonlySnapshot(options.paths) };
    this.load();
  }

  /** 预设目录下当前可用的预设名（每次现读目录：运维加文件即生效，不用重启）。 */
  listPresets(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.options.dir);
    } catch (error) {
      // 目录不存在 = 没配任何预设：命令会报"没有可用预设"而不是抛错
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -'.md'.length))
      .filter((name) => PRESET_NAME_RE.test(name))
      .sort();
  }

  /** 该会话当前选择的预设名（未选 = undefined，即全局默认人设）。 */
  current(conversationKey: string): string | undefined {
    return this.selections.get(conversationKey);
  }

  /**
   * 切换会话人设：把预设写进工作区 AGENTS.md 的标记区块，并持久化选择。
   * 成功即生效（下一个 turn 由 dsh-agent-instructions 拾起），不动 runtime。
   */
  apply(conversationKey: string, name: string): PersonaApplyResult {
    const content = this.readPreset(name);
    if (typeof content !== 'string') return content;
    const trimmed = content.trim();
    if (trimmed === '') {
      return { ok: false, reason: 'empty-preset', detail: `预设 ${name} 内容为空` };
    }
    try {
      this.commitSelection(conversationKey, name, () => {
        this.writeBlock(conversationKey, name, trimmed);
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'io',
        detail: error instanceof Error ? error.message : String(error),
        error: failure(
          error instanceof AggregateError ? 'UNKNOWN_OUTCOME' : 'PERSISTENCE_FAILED',
          error
        ),
      };
    }
    this.options.logger.info('会话人设已切换', { conversation: conversationKey, persona: name });
    return { ok: true, name };
  }

  /** 恢复全局默认人设：移除标记区块（保留区块外手写内容）+ 清除选择。 */
  clear(conversationKey: string): { hadSelection: boolean } {
    const hadSelection = this.selections.has(conversationKey);
    this.commitSelection(conversationKey, undefined, () => {
      this.clearBlock(conversationKey);
    });
    this.options.logger.info('会话人设已恢复默认', { conversation: conversationKey, hadSelection });
    return { hadSelection };
  }

  /**
   * 启动期回放：把每个已选会话的区块**幂等重写**。
   * 预设文件已消失的会话：告警并丢弃选择（人设悄悄回默认比启动失败好）。
   */
  restoreAll(): void {
    for (const [conversationKey, name] of [...this.selections.entries()]) {
      const content = this.readPreset(name);
      if (typeof content !== 'string') {
        this.options.logger.warn('持久化的人设预设已不存在，丢弃该选择', {
          conversation: conversationKey,
          persona: name,
          reason: content.reason,
        });
        const next = new Map(this.selections);
        next.delete(conversationKey);
        this.persist(next);
        this.selections.delete(conversationKey);
        continue;
      }
      try {
        this.writeBlock(conversationKey, name, content.trim());
      } catch (error) {
        this.options.logger.warn('人设区块回放失败（下次切换时再修）', {
          conversation: conversationKey,
          persona: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 读预设内容；失败返回 ApplyFail（调用方直接透传给命令回复）。 */
  private readPreset(name: string): string | PersonaApplyFail {
    if (!PRESET_NAME_RE.test(name)) {
      return {
        ok: false,
        reason: 'invalid-name',
        detail: `预设名只能是小写字母/数字/中划线，收到 ${JSON.stringify(name)}`,
      };
    }
    // 双保险：正则之外再确认解析结果没跑出预设目录
    const file = resolve(this.options.dir, `${name}.md`);
    if (!file.startsWith(resolve(this.options.dir) + sep)) {
      return { ok: false, reason: 'invalid-name', detail: '预设路径越界' };
    }
    if (!existsSync(file)) {
      return { ok: false, reason: 'unknown-preset', detail: `没有名叫 ${name} 的预设` };
    }
    const content = readFileSync(file, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_PRESET_BYTES) {
      return {
        ok: false,
        reason: 'preset-too-large',
        detail: `预设 ${name} 超过 ${MAX_PRESET_BYTES} 字节：人设每轮都进上下文，写短一点`,
      };
    }
    return content;
  }

  /** 把区块写进工作区 AGENTS.md：已有区块则替换，没有则追加到文末。 */
  private writeBlock(conversationKey: string, name: string, content: string): void {
    const file = this.agentsFileFor(conversationKey);
    const block = [
      `<!-- qqbot-persona:begin name="${name}" -->`,
      '<!-- 此区块由 /persona 命令维护；手工改这里会被下次切换覆盖，请改区块之外 -->',
      '',
      content,
      '',
      BLOCK_END,
    ].join('\n');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let next: string;
    if (BLOCK_RE.test(existing)) next = existing.replace(BLOCK_RE, `\n${block}\n`);
    else if (existing.trimEnd() === '') next = `${block}\n`;
    else next = `${existing.trimEnd()}\n\n${block}\n`;
    this.writeFileAtomic(file, next);
  }

  private agentsFileFor(conversationKey: string): string {
    ensureWorkspace(this.options.paths, conversationKey);
    return join(workspacePathFor(this.options.paths, conversationKey), AGENTS_FILE);
  }

  private clearBlock(conversationKey: string): void {
    const file = this.agentsFileFor(conversationKey);
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    if (BLOCK_RE.test(text)) {
      this.writeFileAtomic(file, `${text.replace(BLOCK_RE, '\n').trimEnd()}\n`);
    }
  }

  /** 两个文件无法一次 rename；选择写入失败时回滚区块，内存始终最后提交。 */
  private commitSelection(
    conversationKey: string,
    name: string | undefined,
    write: () => void
  ): void {
    const file = this.agentsFileFor(conversationKey);
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = new Map(this.selections);
    if (name === undefined) next.delete(conversationKey);
    else next.set(conversationKey, name);
    try {
      write();
      this.persist(next);
    } catch (cause) {
      this.restoreBlock(file, previous, cause);
      throw new Error('人设选择持久化失败，保留原选择', { cause });
    }
    this.selections.clear();
    for (const [key, selected] of next) this.selections.set(key, selected);
  }

  private restoreBlock(file: string, previous: string, cause: unknown): void {
    try {
      this.writeFileAtomic(file, previous);
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], '人设区块回滚失败，结果未知', {
        cause: rollbackCause,
      });
    }
  }

  /** 原子写：先写临时文件再 rename，不给读者半截文件。 */
  private writeFileAtomic(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  }

  private load(): void {
    const file = this.options.persistPath;
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistShape>;
      if (parsed.version !== 1 || typeof parsed.personas !== 'object' || parsed.personas === null) {
        this.options.logger.warn('personas.json 结构不认识，忽略并重建');
        return;
      }
      for (const [key, name] of Object.entries(parsed.personas)) {
        if (typeof name === 'string' && PRESET_NAME_RE.test(name)) {
          this.selections.set(key, name);
        }
      }
      this.options.logger.info('已加载人设选择', { personas: this.selections.size });
    } catch (error) {
      // 选择文件损坏不是致命错误：最坏情况是人设回默认，功能不受影响
      this.options.logger.warn('personas.json 解析失败，将忽略（人设回到默认）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persist(selections: ReadonlyMap<string, string>): void {
    const file = this.options.persistPath;
    const payload: PersistShape = {
      version: 1,
      personas: Object.fromEntries(selections),
    };
    try {
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      if (this.options.persistSelection) {
        this.options.persistSelection(file, text);
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      this.options.logger.warn('写入 personas.json 失败，保留原选择', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
