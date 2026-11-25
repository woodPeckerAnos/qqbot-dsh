import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BotConnector,
  MessageContext,
  NormalizedEvent,
  OutgoingMessage,
  ReplyContext,
} from '@qqbot/contracts';
import { createDedupeStage } from '../src/pipeline/ingress/dedupe.js';
import { createRecordStage } from '../src/pipeline/ingress/record.js';
import { handleWelcomeEvent } from '../src/pipeline/ingress/welcome.js';
import { createNullLogger } from '../src/logger.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { SeenStore } from '../src/store/seen.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    message: {
      kind: 'group-at-message',
      target: { platform: 'onebot', kind: 'group', id: 'G1', key: 'ob11:g1' },
      eventId: 'E1',
      msgId: 'M1',
      senderId: 'U1',
      username: 'Alice',
      content: '你好',
      ts: 1_700_000_000_000,
      raw: {},
    },
    isAdmin: false,
    logger: createNullLogger(),
    ...overrides,
  } as MessageContext;
}

function storePaths() {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-ingress-'));
  cleanups.push(root);
  const paths = resolveStorePaths({
    workspacesRoot: join(root, 'workspaces'),
    stateDir: join(root, 'bot'),
  });
  ensureStoreDirs(paths);
  return paths;
}

describe('Ingress 去重与记录', () => {
  it('相同 eventId 只放行一次，空 eventId 回退 msgId，重复不产生副作用', async () => {
    const paths = storePaths();
    const stats = new PipelineStats();
    const stage = createDedupeStage({
      seen: new SeenStore({ paths, logger: createNullLogger() }),
      stats,
    });
    let proceeded = 0;
    const next = async () => {
      proceeded += 1;
    };
    await stage(makeContext(), next);
    await stage(makeContext(), next);
    expect(proceeded).toBe(1);
    expect(stats.snapshot().deduplicated).toBe(1);

    const base = makeContext();
    const noEvent = makeContext({
      message: { ...base.message, eventId: '', msgId: 'M2' },
    });
    await stage(noEvent, next);
    await stage(noEvent, next);
    expect(proceeded).toBe(2);
  });

  it('记录 stage 把用户消息写入对应会话，不写其他会话', async () => {
    const paths = storePaths();
    const conversations = new ConversationStore(paths, createNullLogger());
    const stage = createRecordStage({ conversations });
    let proceeded = 0;
    await stage(makeContext(), async () => {
      proceeded += 1;
    });
    expect(proceeded).toBe(1);
    expect(conversations.readAll('ob11:g1')[0]).toMatchObject({
      role: 'user',
      speaker: 'Alice',
      text: '你好',
    });
    expect(conversations.readAll('ob11:g2')).toEqual([]);
  });
});

describe('进群/加好友欢迎', () => {
  function connector(acceptsC2C = true) {
    const calls: { context: ReplyContext; message: OutgoingMessage }[] = [];
    const value = {
      acceptsC2C,
      reply: async (context: ReplyContext, message: OutgoingMessage) => {
        calls.push({ context, message });
      },
    } as unknown as BotConnector;
    return { value, calls };
  }

  it('群进群事件用 event_id 回复并说明 @', async () => {
    const stats = new PipelineStats();
    const fake = connector();
    const event = {
      kind: 'group-add-robot',
      target: { platform: 'onebot', kind: 'group', id: 'G1', key: 'ob11:g1' },
      eventId: 'EV1',
    } as NormalizedEvent;
    await handleWelcomeEvent(event, {
      connectors: new Map([['onebot', fake.value]]),
      stats,
      logger: createNullLogger(),
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.context).toMatchObject({ eventId: 'EV1', seq: 1, kind: 'final' });
    expect(fake.calls[0]?.message.text).toContain('@');
    expect(stats.snapshot().repliesSent).toBe(1);
  });

  it('单聊未启用时不发欢迎语', async () => {
    const stats = new PipelineStats();
    const fake = connector(false);
    const event = {
      kind: 'c2c-friend-add',
      target: { platform: 'onebot', kind: 'c2c', id: 'U1', key: 'ob11:u1' },
      eventId: 'EV2',
    } as NormalizedEvent;
    await handleWelcomeEvent(event, {
      connectors: new Map([['onebot', fake.value]]),
      stats,
      logger: createNullLogger(),
    });
    expect(fake.calls).toHaveLength(0);
    expect(stats.snapshot().repliesSent).toBe(0);
  });
});
