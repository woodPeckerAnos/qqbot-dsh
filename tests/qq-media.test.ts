/**
 * 官方适配器富媒体出站测试：/files 上传 + msg_type=7 媒体消息。
 *
 * 用 fetchImpl 注入假的 OpenAPI：验证请求体形状（file_type / srv_send_msg=false /
 * file_info / msg_id / msg_seq），不发真实网络请求。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { QqOfficialConnector } from '../src/adapters/qq-official/connector.js';
import { renderMediaMessage } from '../src/adapters/qq-official/render.js';
import { MsgType } from '../src/adapters/qq-official/types.js';
import type { ReplyPolicy } from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';

const POLICY: ReplyPolicy = {
  maxChars: 1500,
  maxRepliesPerMsg: 4,
  progressMax: 3,
  progressAfterMs: 90_000,
  progressIntervalMs: 90_000,
  turnTimeoutMs: 240_000,
  passiveWindowMs: 300_000,
};

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** 假 OpenAPI：token → 固定值；/files → file_info；/messages → 成功。 */
function makeFakeApi(): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url, body });
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/app/getAppAccessToken')) {
      return json({ access_token: 'TOKEN', expires_in: '7200' });
    }
    if (url.includes('/files')) {
      return json({ file_info: 'FILE-INFO-1', ttl: 300 });
    }
    return json({ id: 'msg-1', timestamp: '2026-01-01T00:00:00+08:00' });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function makeConnector(fetchImpl: typeof fetch): QqOfficialConnector {
  return new QqOfficialConnector({
    appId: 'app-id',
    appSecret: 'app-secret',
    apiBase: 'https://api.bot.qq.com',
    intents: 50331648,
    msgType: 0,
    acceptsC2C: true,
    groupPolicy: POLICY,
    c2cPolicy: POLICY,
    logger: createNullLogger(),
    fetchImpl,
  });
}

let dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('官方适配器富媒体出站', () => {
  it('图片附件：先上传（file_type=1, srv_send_msg=false），再发 msg_type=7', async () => {
    const { fetchImpl, requests } = makeFakeApi();
    const connector = makeConnector(fetchImpl);

    const dir = await mkdtemp(join(tmpdir(), 'qqbot-qq-media-'));
    dirs.push(dir);
    const absPath = join(dir, 'pic.png');
    await writeFile(absPath, 'fake-png-bytes');

    await connector.reply(
      { target: { platform: 'qq-official', kind: 'group', id: 'GROUP1', key: 'GROUP1' }, seq: 2, kind: 'final', msgId: 'MSG1' },
      { text: '', attachments: [{ kind: 'image', absPath, fileName: 'pic.png', sizeBytes: 14 }] },
    );

    const upload = requests.find((r) => r.url.includes('/files'));
    expect(upload?.url).toBe('https://api.bot.qq.com/v2/groups/GROUP1/files');
    expect(upload?.body['file_type']).toBe(1);
    expect(upload?.body['srv_send_msg']).toBe(false);
    expect(upload?.body['file_data']).toBe(Buffer.from('fake-png-bytes').toString('base64'));

    const message = requests.find((r) => r.url.includes('/messages'));
    expect(message?.url).toBe('https://api.bot.qq.com/v2/groups/GROUP1/messages');
    expect(message?.body['msg_type']).toBe(MsgType.MEDIA);
    expect(message?.body['media']).toEqual({ file_info: 'FILE-INFO-1' });
    // 被动回复语义保持：msg_id 与 msg_seq 照带
    expect(message?.body['msg_id']).toBe('MSG1');
    expect(message?.body['msg_seq']).toBe(2);
  });

  it('文件附件（file 类型）：走单聊端点，file_type=4', async () => {
    const { fetchImpl, requests } = makeFakeApi();
    const connector = makeConnector(fetchImpl);

    const dir = await mkdtemp(join(tmpdir(), 'qqbot-qq-media-'));
    dirs.push(dir);
    const absPath = join(dir, 'run.sh');
    await writeFile(absPath, '#!/bin/sh');

    await connector.reply(
      { target: { platform: 'qq-official', kind: 'c2c', id: 'USER1', key: 'c2c:USER1' }, seq: 1, kind: 'final', msgId: 'MSG2' },
      { text: '', attachments: [{ kind: 'file', absPath, fileName: 'run.sh', sizeBytes: 9 }] },
    );

    const upload = requests.find((r) => r.url.includes('/files'));
    expect(upload?.url).toBe('https://api.bot.qq.com/v2/users/USER1/files');
    expect(upload?.body['file_type']).toBe(4);

    const message = requests.find((r) => r.url.includes('/messages'));
    expect(message?.url).toBe('https://api.bot.qq.com/v2/users/USER1/messages');
    expect(message?.body['msg_type']).toBe(MsgType.MEDIA);
  });

  it('上传响应缺 file_info 时报错（由 Responder 走单附件失败路径）', async () => {
    const { fetchImpl } = makeFakeApi();
    const broken: typeof fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/app/getAppAccessToken')) return json({ access_token: 'TOKEN', expires_in: '7200' });
      if (url.includes('/files')) return json({ ttl: 300 }); // 没有 file_info
      return json({});
      void init;
    }) as unknown as typeof fetch;
    void fetchImpl;
    const connector = makeConnector(broken);

    const dir = await mkdtemp(join(tmpdir(), 'qqbot-qq-media-'));
    dirs.push(dir);
    const absPath = join(dir, 'a.png');
    await writeFile(absPath, 'x');

    await expect(
      connector.reply(
        { target: { platform: 'qq-official', kind: 'group', id: 'G', key: 'G' }, seq: 1, kind: 'final', msgId: 'M' },
        { text: '', attachments: [{ kind: 'image', absPath, fileName: 'a.png', sizeBytes: 1 }] },
      ),
    ).rejects.toThrow(/file_info/);
  });
});

describe('renderMediaMessage', () => {
  it('msg_type=7，带 media.file_info，msg_id 与 event_id 互斥', () => {
    const body = renderMediaMessage('FI', { msgSeq: 3, msgId: 'M1', eventId: 'E1' });
    expect(body.msg_type).toBe(7);
    expect(body.media).toEqual({ file_info: 'FI' });
    expect(body.msg_seq).toBe(3);
    expect(body.msg_id).toBe('M1');
    expect(body.event_id).toBeUndefined();
    // 不携带文本字段（按"media 不可携带 content"的假设设计）
    expect(body.content).toBeUndefined();
  });

  it('msg_id 为空时退回 event_id', () => {
    const body = renderMediaMessage('FI', { msgSeq: 1, msgId: '', eventId: 'E1' });
    expect(body.msg_id).toBeUndefined();
    expect(body.event_id).toBe('E1');
  });
});
