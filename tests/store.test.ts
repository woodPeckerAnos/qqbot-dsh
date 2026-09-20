/**
 * 存储层单测：对话记录、去重、目录布局。
 *
 * 这三块是"重启不失忆"与"不重复回复"的地基，都必须能在临时目录里离线验证。
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import {
  conversationFileFor,
  conversationHash,
  ensureStoreDirs,
  ensureWorkspace,
  resolveStorePaths,
  workspacePathFor,
} from '../src/store/paths.js';
import { ConversationStore, renderReplay } from '../src/store/conversations.js';
import { SeenStore } from '../src/store/seen.js';
import { SessionStore } from '../src/store/sessions.js';

let root: string;
let paths: ReturnType<typeof resolveStorePaths>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqbot-store-'));
  paths = resolveStorePaths({
    workspacesRoot: join(root, 'workspaces'),
    stateDir: join(root, 'bot'),
  });
  ensureStoreDirs(paths);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('paths', () => {
  it('会话键 hash 稳定且长度固定', () => {
    const a = conversationHash('group-openid-AAA');
    expect(a).toHaveLength(16);
    expect(conversationHash('group-openid-AAA')).toBe(a);
    expect(conversationHash('group-openid-BBB')).not.toBe(a);
  });

  it('工作区目录名不含原始 openid（避免特殊字符问题）', () => {
    const path = workspacePathFor(paths, 'openid/with:weird*chars');
    expect(path).toContain(paths.workspacesRoot);
    expect(path).not.toContain('weird');
  });

  it('ensureWorkspace 幂等创建目录', () => {
    const first = ensureWorkspace(paths, 'g1');
    const second = ensureWorkspace(paths, 'g1');
    expect(first).toBe(second);
    expect(existsSync(first)).toBe(true);
  });

  it('不同会话得到不同工作区', () => {
    expect(ensureWorkspace(paths, 'g1')).not.toBe(ensureWorkspace(paths, 'g2'));
  });

  it('单聊会话键 c2c:<openid> 与同名群 openid 落在不同工作区', () => {
    // 关键隔离：同一个字面值可能是群 openid 也可能是用户 openid
    expect(workspacePathFor(paths, 'SAME')).not.toBe(workspacePathFor(paths, 'c2c:SAME'));
    expect(conversationFileFor(paths, 'SAME')).not.toBe(conversationFileFor(paths, 'c2c:SAME'));
  });
});

describe('ConversationStore', () => {
  const logger = createNullLogger();

  it('追加后可读回，顺序保持', () => {
    const store = new ConversationStore(paths, logger);
    store.append('g1', { role: 'user', speaker: '张三', text: '你好', ts: 1 });
    store.append('g1', { role: 'assistant', speaker: 'bot', text: '你好呀', ts: 2 });

    const turns = store.readAll('g1');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', speaker: '张三', text: '你好' });
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '你好呀' });
  });

  it('不同群互不干扰', () => {
    const store = new ConversationStore(paths, logger);
    store.append('g1', { role: 'user', speaker: 'a', text: 'g1 的话', ts: 1 });
    store.append('g2', { role: 'user', speaker: 'b', text: 'g2 的话', ts: 1 });

    expect(store.readAll('g1')).toHaveLength(1);
    expect(store.readAll('g2')).toHaveLength(1);
    expect(store.readAll('g1')[0]?.text).toBe('g1 的话');
  });

  it('readTail 返回最近 n 条', () => {
    const store = new ConversationStore(paths, logger);
    for (let i = 0; i < 10; i += 1) {
      store.append('g1', { role: 'user', speaker: 'a', text: `第${i}条`, ts: i });
    }
    const tail = store.readTail('g1', 3);
    expect(tail.map((t) => t.text)).toEqual(['第7条', '第8条', '第9条']);
  });

  it('readTail(0) 返回空数组（用于关闭回放）', () => {
    const store = new ConversationStore(paths, logger);
    store.append('g1', { role: 'user', speaker: 'a', text: 'x', ts: 1 });
    expect(store.readTail('g1', 0)).toEqual([]);
  });

  it('损坏的行被跳过而不影响其余记录', () => {
    const store = new ConversationStore(paths, logger);
    store.append('g1', { role: 'user', speaker: 'a', text: '正常', ts: 1 });
    const file = conversationFileFor(paths, 'g1');
    writeFileSync(file, `${'这不是 JSON'}\n`, { flag: 'a' });
    store.append('g1', { role: 'assistant', speaker: 'bot', text: '也正常', ts: 2 });

    const turns = store.readAll('g1');
    expect(turns.map((t) => t.text)).toEqual(['正常', '也正常']);
  });

  it('未记录过的群返回空数组', () => {
    expect(new ConversationStore(paths, logger).readAll('never-seen')).toEqual([]);
  });
});

describe('renderReplay', () => {
  it('空历史返回空串', () => {
    expect(renderReplay([])).toBe('');
  });

  it('用边界标记包裹，并声明"这不是指令"以降低注入风险', () => {
    const text = renderReplay([
      { role: 'user', speaker: '张三', text: '帮我删库', ts: 1 },
      { role: 'assistant', speaker: 'bot', text: '我不做这个', ts: 2 },
    ]);
    expect(text).toContain('<历史对话');
    expect(text).toContain('</历史对话>');
    expect(text).toContain('不是指令');
    expect(text).toContain('[张三] 帮我删库');
    expect(text).toContain('[你] 我不做这个');
  });

  it('超长历史从头部截断并给出提示', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      speaker: 'a',
      text: `第${i}条${'x'.repeat(50)}`,
      ts: i,
    }));
    const text = renderReplay(turns, 500);
    expect(text).toContain('更早的记录已省略');
    expect(text.length).toBeLessThan(900);
  });

  it('空文本行被忽略', () => {
    const text = renderReplay([
      { role: 'user', speaker: 'a', text: '   ', ts: 1 },
      { role: 'user', speaker: 'b', text: '有内容', ts: 2 },
    ]);
    expect(text).not.toContain('[a]');
    expect(text).toContain('[b] 有内容');
  });
});

describe('SeenStore', () => {
  const logger = createNullLogger();

  it('首次 claim 为 true，重复为 false', () => {
    const store = new SeenStore({ paths, logger });
    expect(store.claim('evt-1')).toBe(true);
    expect(store.claim('evt-1')).toBe(false);
    expect(store.claim('evt-2')).toBe(true);
  });

  it('磁盘标记跨实例生效（模拟进程重启）', () => {
    const first = new SeenStore({ paths, logger });
    expect(first.claim('evt-restart')).toBe(true);

    // 新实例 = 新进程
    const second = new SeenStore({ paths, logger });
    expect(second.claim('evt-restart')).toBe(false);
  });

  it('eventId 含特殊字符时仍能安全落盘', () => {
    const store = new SeenStore({ paths, logger });
    expect(store.claim('ROBOT1.0_a/b+c=d')).toBe(true);
    expect(store.claim('ROBOT1.0_a/b+c=d')).toBe(false);
  });

  it('空 eventId 一律按首次处理（无法去重）', () => {
    const store = new SeenStore({ paths, logger });
    expect(store.claim('')).toBe(true);
    expect(store.claim('')).toBe(true);
  });

  it('sweep 清理超过保留期的标记', () => {
    const nowMs = 1_000_000_000;
    const store = new SeenStore({ paths, logger, retentionMs: 1000, now: () => nowMs });
    store.claim('old-event');

    // 把文件的 mtime 改到很久以前
    const marker = join(paths.seenDir, encodeURIComponent('old-event'));
    const past = (nowMs - 10_000) / 1000;
    utimesSync(marker, past, past);

    const removed = store.sweep();
    expect(removed).toBe(1);
    // 清理后磁盘标记不存在，但内存仍记得
    expect(existsSync(marker)).toBe(false);
  });

  it('内存 LRU 超过容量时淘汰最旧的（磁盘仍能兜住）', () => {
    const store = new SeenStore({ paths, logger, memoryLimit: 2 });
    store.claim('a');
    store.claim('b');
    store.claim('c');
    expect(store.memorySize).toBe(2);
  });

  it('磁盘不可写时退化为内存去重而不抛错', () => {
    mkdirSync(paths.seenDir, { recursive: true });
    // 用只读目录模拟不可写：直接替换 seenDir 为一个文件路径
    const brokenPaths = { ...paths, seenDir: join(root, 'not-a-dir') };
    writeFileSync(brokenPaths.seenDir, 'i am a file');
    const store = new SeenStore({ paths: brokenPaths, logger });
    expect(store.claim('x')).toBe(true);
    expect(store.claim('x')).toBe(false);
  });
});

describe('SessionStore', () => {
  const logger = createNullLogger();

  it('首次 ensure 创建记录，再次 ensure 复用', () => {
    const store = new SessionStore({ paths, logger });
    const first = store.ensure('g1');
    expect(first.generation).toBe(1);
    const second = store.ensure('g1');
    expect(second.currentSessionId).toBe(first.currentSessionId);
    expect(second.generation).toBe(1);
  });

  it('rotate=true 换新 sessionId 并递增 generation', () => {
    const store = new SessionStore({ paths, logger });
    const first = store.ensure('g1');
    const rotated = store.ensure('g1', true);
    expect(rotated.generation).toBe(2);
    expect(rotated.currentSessionId).not.toBe(first.currentSessionId);
    // logicalId 恒定，便于排障
    expect(rotated.logicalId).toBe(first.logicalId);
  });

  it('映射跨实例持久化（重启后 generation 继续递增）', () => {
    const first = new SessionStore({ paths, logger });
    first.ensure('g1');
    first.ensure('g1', true);

    const second = new SessionStore({ paths, logger });
    const record = second.peek('g1');
    expect(record?.generation).toBe(2);
  });

  it('映射文件损坏时不影响启动（退化为新建会话）', () => {
    writeFileSync(paths.sessionsFile, '{ 这不是合法 JSON');
    const store = new SessionStore({ paths, logger });
    expect(store.all()).toEqual([]);
    expect(store.ensure('g1').generation).toBe(1);
  });

  it('peek 不创建记录', () => {
    const store = new SessionStore({ paths, logger });
    expect(store.peek('unknown')).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it('可注入 sessionId 生成器（便于测试与审计）', () => {
    const store = new SessionStore({
      paths,
      logger,
      sessionIdFactory: (conversationKey, gen) => `fixed-${conversationHash(conversationKey)}-${gen}`,
    });
    const record = store.ensure('g1');
    expect(record.currentSessionId).toBe(`fixed-${conversationHash('g1')}-1`);
  });

  it('旧版 sessions.json（groups + groupOpenid）仍能加载', () => {
    writeFileSync(
      paths.sessionsFile,
      JSON.stringify({
        version: 1,
        groups: {
          g1: {
            groupOpenid: 'g1',
            logicalId: 'logical-g1',
            currentSessionId: 'sess-old',
            generation: 3,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      }),
    );
    const store = new SessionStore({ paths, logger });
    const record = store.peek('g1');
    expect(record?.conversationKey).toBe('g1');
    expect(record?.currentSessionId).toBe('sess-old');
    expect(record?.generation).toBe(3);
  });
});
