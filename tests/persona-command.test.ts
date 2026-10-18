/**
 * /persona 命令单测：解析形态 + 管理员闸门 + 命令行为（全离线）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import {
  PersonaCommandRouter,
  parsePersonaCommand,
} from '../src/pipeline/ingress/persona-command.js';
import type { MessageContext } from '../src/pipeline/ingress/types.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { PersonaStore } from '../src/store/personas.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';

describe('parsePersonaCommand', () => {
  it('裸命令 = list；带名 = set；off/default = clear', () => {
    expect(parsePersonaCommand('/persona')).toEqual({ kind: 'list' });
    expect(parsePersonaCommand('  /persona  ')).toEqual({ kind: 'list' });
    expect(parsePersonaCommand('/persona concise')).toEqual({ kind: 'set', name: 'concise' });
    expect(parsePersonaCommand('/persona Teacher')).toEqual({ kind: 'set', name: 'teacher' });
    expect(parsePersonaCommand('/persona off')).toEqual({ kind: 'clear' });
    expect(parsePersonaCommand('/persona default')).toEqual({ kind: 'clear' });
  });

  it('兼容官方平台的 <@!id> 前缀', () => {
    expect(parsePersonaCommand('<@!12345> /persona concise')).toEqual({
      kind: 'set',
      name: 'concise',
    });
  });

  it('非 /persona 消息不拦截；多词参数回 list（usage）', () => {
    expect(parsePersonaCommand('/new')).toBeUndefined();
    expect(parsePersonaCommand('今天 /persona 一下')).toBeUndefined();
    expect(parsePersonaCommand('/persona a b')).toEqual({ kind: 'list' });
  });
});

describe('PersonaCommandRouter stage', () => {
  let root: string;
  let presetDir: string;
  let personas: PersonaStore;
  let stats: PipelineStats;
  let router: PersonaCommandRouter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qqbot-persona-cmd-'));
    const paths = resolveStorePaths({
      workspacesRoot: join(root, 'workspaces'),
      stateDir: join(root, 'bot'),
    });
    ensureStoreDirs(paths);
    presetDir = join(root, 'personas');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'concise.md'), '极简风格。\n');
    personas = new PersonaStore({
      dir: presetDir,
      persistPath: join(paths.stateDir, 'personas.json'),
      paths,
      logger: createNullLogger(),
    });
    stats = new PipelineStats();
    router = new PersonaCommandRouter({ personas, stats });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeCtx(content: string, isAdmin: boolean) {
    const replies: string[] = [];
    let proceeded = false;
    const ctx = {
      message: {
        kind: 'group-at-message',
        target: { platform: 'onebot', kind: 'group', id: 'G1', key: 'G1' },
        eventId: 'E1',
        msgId: 'M1',
        senderId: 'U1',
        content,
        ts: 1_700_000_000_000,
        raw: {},
      },
      isAdmin,
      logger: createNullLogger(),
      responder: {
        error: async (text: string) => {
          replies.push(text);
        },
      },
    } as unknown as MessageContext;
    const next = async () => {
      proceeded = true;
    };
    return { ctx, next, replies, proceeded: () => proceeded };
  }

  it('非管理员被拒绝，不进后续 stage', async () => {
    const { ctx, next, replies, proceeded } = makeCtx('/persona concise', false);
    await router.stage()(ctx, next);
    expect(proceeded()).toBe(false);
    expect(replies[0]).toContain('无权限');
  });

  it('list：列出预设与当前选择', async () => {
    const { ctx, next, replies } = makeCtx('/persona', true);
    await router.stage()(ctx, next);
    expect(replies[0]).toContain('concise');
    expect(replies[0]).toContain('默认');
  });

  it('set：切换成功并持久化；未知预设报错并附可用清单', async () => {
    const ok = makeCtx('/persona concise', true);
    await router.stage()(ok.ctx, ok.next);
    expect(ok.replies[0]).toContain('concise');
    expect(personas.current('G1')).toBe('concise');

    const bad = makeCtx('/persona nope', true);
    await router.stage()(bad.ctx, bad.next);
    expect(bad.replies[0]).toContain('切换失败');
    expect(bad.replies[0]).toContain('concise');
  });

  it('clear：恢复默认', async () => {
    personas.apply('G1', 'concise');
    const { ctx, next, replies } = makeCtx('/persona off', true);
    await router.stage()(ctx, next);
    expect(personas.current('G1')).toBeUndefined();
    expect(replies[0]).toContain('默认');
  });

  it('非命令消息照常放行', async () => {
    const { ctx, next, replies, proceeded } = makeCtx('帮我核查一下这个新闻', true);
    await router.stage()(ctx, next);
    expect(proceeded()).toBe(true);
    expect(replies).toHaveLength(0);
  });
});
