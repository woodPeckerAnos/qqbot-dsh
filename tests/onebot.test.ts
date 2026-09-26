/**
 * OneBot 适配器测试：归一化纯函数 + 反向 WS 全回路（真实 socket，全离线）。
 *
 * 全回路用真实 WS 服务器与客户端（localhost），验证的是协议层最容易错的部分：
 *   - token 鉴权（header 与 query 两种形式）；
 *   - 事件进来 → 归一化 → 吐给编排层；
 *   - reply() → action 帧出去 → echo 对回响应；
 *   - 鉴权失败直接 401，不进入 WS 层。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import {
  OnebotConnector,
  ONEBOT_PLATFORM,
  type OnebotConnectorOptions,
} from '../src/adapters/onebot/connector.js';
import {
  extractGroupContent,
  normalizeOneBotEvent,
  onebotC2cTarget,
  onebotGroupTarget,
  quotedAuthorFromGetMsg,
  quotedPartsFromGetMsg,
} from '../src/adapters/onebot/normalize.js';
import type { NormalizedEvent, NormalizedMessage } from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';

// ---------------------------------------------------------------------------
// 归一化（纯函数）
// ---------------------------------------------------------------------------

describe('OneBot 归一化', () => {
  it('群消息：@ 机器人时归一化为 group-at-message，正文剥掉 at 段', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 42,
      group_id: 8888,
      user_id: 12345,
      time: 1_700_000_000,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' 帮我写个脚本' } },
      ],
      sender: { user_id: 12345, nickname: '小明', card: '群名片' },
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    const event = result.event;
    expect(event.kind).toBe('group-at-message');
    if (event.kind !== 'group-at-message') return;
    expect(event.target).toEqual({
      platform: ONEBOT_PLATFORM,
      kind: 'group',
      id: '8888',
      key: 'ob11:g8888',
    });
    expect(event.content).toBe('帮我写个脚本');
    expect(event.senderId).toBe('12345');
    // 群名片优先于昵称
    expect(event.username).toBe('群名片');
    expect(event.eventId).toBe('ob11:10000:42');
    expect(event.ts).toBe(1_700_000_000_000);
  });

  it('群消息：没 @ 机器人时忽略', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 1,
      group_id: 8888,
      user_id: 12345,
      message: [{ type: 'text', data: { text: '大家好' } }],
    });
    expect(result.type).toBe('ignored');
  });

  it('群消息：机器人自己发的消息忽略（防自触发循环）', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      self_id: 10000,
      message_id: 1,
      group_id: 8888,
      user_id: 10000,
      message: '[CQ:at,qq=10000] 自问自答',
    });
    expect(result.type).toBe('ignored');
  });

  it('CQ 码字符串形式也能识别 at 与正文', () => {
    const { content, atSelf } = extractGroupContent('[CQ:at,qq=10000] 统计一下 [CQ:face,id=178]', 10000);
    expect(atSelf).toBe(true);
    // 表情段现在保留为可读标记（旧行为是整段丢弃）
    expect(content).toBe('统计一下\n[表情]');
  });

  it('图片段归一化为 image 片段（可下载的 http 地址）', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 43,
      group_id: 8888,
      user_id: 12345,
      time: 1_700_000_000,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: '看看这张' } },
        { type: 'image', data: { file: 'a.jpg', url: 'https://cdn.example.com/a.jpg' } },
      ],
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    const event = result.event;
    if (event.kind !== 'group-at-message') return;
    expect(event.parts).toEqual([
      { type: 'text', text: '看看这张' },
      { type: 'image', url: 'https://cdn.example.com/a.jpg', filename: 'a.jpg' },
    ]);
    expect(event.content).toBe('看看这张\n[图片: a.jpg]');
  });

  it('只有图片、没有文字时也算有正文（不再被"@ 之后没有正文"丢掉）', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 44,
      group_id: 8888,
      user_id: 12345,
      time: 1_700_000_000,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'image', data: { url: 'https://cdn.example.com/b.png' } },
      ],
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    expect(result.event.content).toBe('[图片]');
  });

  it('图片只有本地路径（容器里取不到）时降级成文字标记', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 45,
      group_id: 8888,
      user_id: 12345,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'image', data: { file: 'file:///home/qq/a.jpg' } },
      ],
    });
    if (result.type !== 'event') throw new Error('应归一化为事件');
    expect(result.event.content).toBe('[图片]');
  });

  it('reply 段透出被引用消息 id，由连接器回查补全', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 46,
      group_id: 8888,
      user_id: 12345,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'reply', data: { id: '9001' } },
        { type: 'text', data: { text: '这个怎么说' } },
      ],
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    expect(result.quotedMessageId).toBe('9001');
    expect(result.event.content).toBe('这个怎么说');
  });

  it('get_msg 回查结果解析成被引用片段（含被引用图片）', () => {
    const parts = quotedPartsFromGetMsg(
      {
        sender: { nickname: '小红' },
        message: [
          { type: 'text', data: { text: '原来那条' } },
          { type: 'image', data: { url: 'https://cdn.example.com/q.jpg' } },
        ],
      },
      10000,
    );
    expect(parts).toEqual([
      { type: 'text', text: '原来那条' },
      { type: 'image', url: 'https://cdn.example.com/q.jpg' },
    ]);
    expect(quotedAuthorFromGetMsg({ sender: { nickname: '小红' } })).toBe('小红');
  });

  it('私聊（好友）归一化为 c2c-message，会话键带 ob11:u 前缀', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: 10000,
      message_id: 7,
      user_id: 12345,
      time: 1_700_000_000,
      message: '在吗',
      sender: { user_id: 12345, nickname: '张三' },
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    expect(result.event.kind).toBe('c2c-message');
    if (result.event.kind !== 'c2c-message') return;
    expect(result.event.target).toEqual({
      platform: ONEBOT_PLATFORM,
      kind: 'c2c',
      id: '12345',
      key: 'ob11:u12345',
    });
    expect(result.event.content).toBe('在吗');
  });

  it('群临时会话私聊（sub_type=group）不接', () => {
    const result = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'group',
      self_id: 10000,
      message_id: 7,
      user_id: 12345,
      message: '临时消息',
    });
    expect(result.type).toBe('ignored');
  });

  it('notice.group_increase 且 user_id 是自己 → 进群欢迎事件', () => {
    const result = normalizeOneBotEvent({
      post_type: 'notice',
      notice_type: 'group_increase',
      self_id: 10000,
      user_id: 10000,
      group_id: 8888,
      operator_id: 12345,
      time: 1_700_000_000,
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    expect(result.event.kind).toBe('group-add-robot');
    expect(result.event.target?.key).toBe('ob11:g8888');
  });

  it('notice.friend_add → 加好友欢迎事件', () => {
    const result = normalizeOneBotEvent({
      post_type: 'notice',
      notice_type: 'friend_add',
      self_id: 10000,
      user_id: 12345,
      time: 1_700_000_000,
    });
    expect(result.type).toBe('event');
    if (result.type !== 'event') return;
    expect(result.event.kind).toBe('c2c-friend-add');
    expect(result.event.target?.key).toBe('ob11:u12345');
  });

  it('request.friend / request.group(invite) 归一化为审批描述', () => {
    const friend = normalizeOneBotEvent({
      post_type: 'request',
      request_type: 'friend',
      self_id: 10000,
      user_id: 12345,
      flag: 'FLAG-1',
    });
    expect(friend).toEqual({ type: 'friend-request', flag: 'FLAG-1', userId: 12345 });

    const invite = normalizeOneBotEvent({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      self_id: 10000,
      user_id: 12345,
      group_id: 8888,
      flag: 'FLAG-2',
    });
    expect(invite).toEqual({ type: 'group-invite', flag: 'FLAG-2', groupId: 8888, userId: 12345 });
  });

  it('target 工厂：数字与字符串入参等价，命名空间不会与官方碰撞', () => {
    expect(onebotGroupTarget(8888)).toEqual(onebotGroupTarget('8888'));
    expect(onebotC2cTarget(12345).key).toBe('ob11:u12345');
    expect(onebotGroupTarget(8888).key.startsWith('ob11:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 反向 WS 全回路
// ---------------------------------------------------------------------------

function makeConnector(port: number, overrides: Partial<OnebotConnectorOptions> = {}) {
  const events: NormalizedEvent[] = [];
  const connector = new OnebotConnector({
    host: '127.0.0.1',
    port,
    accessToken: 'test-token',
    acceptsC2C: true,
    autoAcceptFriend: true,
    autoAcceptGroupInvite: false,
    replyPolicy: {
      maxChars: 1500,
      maxRepliesPerMsg: 10,
      progressMax: 3,
      progressAfterMs: 90_000,
      progressIntervalMs: 90_000,
      turnTimeoutMs: 600_000,
    },
    logger: createNullLogger(),
    ...overrides,
  });
  connector.on((event) => events.push(event));
  return { connector, events };
}

/** 连上并发送一条 lifecycle connect，完成"框架就绪" */
async function connectClient(
  port: number,
  headers: Record<string, string> = { Authorization: 'Bearer test-token' },
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10000, time: 0 }));
  return ws;
}

describe('OneBot 反向 WS 回路', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('事件归一化进来，reply 以 action 帧发回同一条连接', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    // port 0 = 随机端口，从 health 里拿不到，直接从 server 读
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    // 框架 → 服务：一条 @ 机器人的群消息
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10000,
        message_id: 42,
        group_id: 8888,
        user_id: 12345,
        time: 1_700_000_000,
        message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 你好' } }],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const message = events.find((e) => e.kind === 'group-at-message');
    expect(message).toBeDefined();

    // 服务 → 框架：reply 变成 send_group_msg 动作
    const actionPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    const replyPromise = connector.reply(
      { target: onebotGroupTarget(8888), seq: 1, kind: 'final', msgId: '42' },
      { text: '**你好**，世界' },
    );
    const action = await actionPromise;
    expect(action['action']).toBe('send_group_msg');
    const params = action['params'] as { group_id: number; message: Array<{ type: string; data: { text: string } }> };
    expect(params.group_id).toBe(8888);
    // markdown 被剥成纯文本
    expect(params.message[0]!.data.text).toBe('你好，世界');

    // 框架回响应（echo 对回）→ reply promise 落定
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 100 }, echo: action['echo'] }));
    await replyPromise;
  });

  it('引用消息：reply 段触发 get_msg 回查，被引用内容拼进 quote 片段', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10000,
        message_id: 50,
        group_id: 8888,
        user_id: 12345,
        time: 1_700_000_000,
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'reply', data: { id: '9001' } },
          { type: 'text', data: { text: '这个怎么说' } },
        ],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );

    // 服务 → 框架：先回查被引用的消息
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_msg');
    expect((action['params'] as { message_id: number }).message_id).toBe(9001);

    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: {
          sender: { nickname: '小红' },
          message: [{ type: 'text', data: { text: '原来那条' } }],
        },
        echo: action['echo'],
      }),
    );

    for (let i = 0; i < 100 && !events.some((e) => e.kind === 'group-at-message'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const message = events.find((e): e is NormalizedMessage => e.kind === 'group-at-message');
    expect(message?.content).toBe('[引用 小红] 原来那条\n这个怎么说');
    expect(message?.parts?.[0]).toMatchObject({ type: 'quote', author: '小红' });
  });

  it('错误 retcode 让 reply 抛错（编排层据此走失败路径）', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    const actionPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    const replyPromise = connector.reply(
      { target: onebotC2cTarget(12345), seq: 1, kind: 'final' },
      { text: 'hi' },
    );
    const action = await actionPromise;
    expect(action['action']).toBe('send_private_msg');
    ws.send(JSON.stringify({ status: 'failed', retcode: 1404, wording: '消息发送失败', echo: action['echo'] }));
    await expect(replyPromise).rejects.toThrow(/1404/);
  });

  it('鉴权失败的连接被 401 拒绝', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/v11/ws`, {
          headers: { Authorization: 'Bearer wrong-token' },
        });
        ws.once('open', () => resolve());
        ws.once('error', (error) => reject(error));
        ws.once('unexpected-response', () => reject(new Error('unexpected-response')));
      }),
    ).rejects.toThrow();
  });

  it('加好友请求自动同意：服务主动发 set_friend_add_request', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    const actionPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({
        post_type: 'request',
        request_type: 'friend',
        self_id: 10000,
        user_id: 12345,
        flag: 'FLAG-1',
        time: 0,
      }),
    );
    const action = await actionPromise;
    expect(action['action']).toBe('set_friend_add_request');
    expect((action['params'] as { approve: boolean }).approve).toBe(true);
  });

  it('拉群邀请默认不自动同意（fail-closed）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    let gotAction = false;
    ws.on('message', () => {
      gotAction = true;
    });
    ws.send(
      JSON.stringify({
        post_type: 'request',
        request_type: 'group',
        sub_type: 'invite',
        self_id: 10000,
        user_id: 12345,
        group_id: 8888,
        flag: 'FLAG-2',
        time: 0,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gotAction).toBe(false);
    // 不产生任何归一化事件（邀请不是欢迎事件）
    expect(events.filter((e) => e.kind === 'group-add-robot')).toHaveLength(0);
  });

  it('health：监听中但无客户端时 connected=true 且带告警', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const health = connector.health();
    expect(health.connected).toBe(true);
    expect(health.state).toBe('listening');
    expect(health.warnings?.join('')).toContain('尚无框架客户端');
    await connector.stop();
    expect(connector.health().connected).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 富媒体出站（agent 产物回发）
  // -----------------------------------------------------------------------

  async function makeAttachmentFile(name: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'qqbot-onebot-media-'));
    tempDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  }

  /** 回复并等框架侧收到 n 个 action 帧，逐个回 ok。 */
  async function replyAndCollect(
    ws: WebSocket,
    replyPromise: Promise<void>,
    count: number,
  ): Promise<Record<string, unknown>[]> {
    const actions: Record<string, unknown>[] = [];
    const allReceived = new Promise<void>((resolve) => {
      const handler = (data: WebSocket.RawData): void => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame['action'] === undefined) return;
        actions.push(frame);
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 100 }, echo: frame['echo'] }));
        if (actions.length >= count) {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });
    await Promise.all([replyPromise, allReceived]);
    return actions;
  }

  it('图片附件：send_group_msg 带 image 段，默认 base64 传输', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    const absPath = await makeAttachmentFile('pic.png', 'fake-png-bytes');
    const actions = await replyAndCollect(
      ws,
      connector.reply(
        { target: onebotGroupTarget(8888), seq: 1, kind: 'final' },
        { text: '', attachments: [{ kind: 'image', absPath, fileName: 'pic.png', sizeBytes: 14 }] },
      ),
      1,
    );
    expect(actions[0]!['action']).toBe('send_group_msg');
    const params = actions[0]!['params'] as { group_id: number; message: Array<{ type: string; data: { file: string } }> };
    expect(params.group_id).toBe(8888);
    expect(params.message[0]!.type).toBe('image');
    expect(params.message[0]!.data.file).toBe(`base64://${Buffer.from('fake-png-bytes').toString('base64')}`);
  });

  it('文件附件：群走 upload_group_file，单聊走 upload_private_file', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    const groupFile = await makeAttachmentFile('run.sh', '#!/bin/sh');
    const groupActions = await replyAndCollect(
      ws,
      connector.reply(
        { target: onebotGroupTarget(8888), seq: 1, kind: 'final' },
        { text: '', attachments: [{ kind: 'file', absPath: groupFile, fileName: 'run.sh', sizeBytes: 9 }] },
      ),
      1,
    );
    expect(groupActions[0]!['action']).toBe('upload_group_file');
    const groupParams = groupActions[0]!['params'] as { group_id: number; file: string; name: string };
    expect(groupParams.group_id).toBe(8888);
    expect(groupParams.name).toBe('run.sh');
    expect(groupParams.file.startsWith('base64://')).toBe(true);

    const c2cFile = await makeAttachmentFile('page.html', '<html/>');
    const c2cActions = await replyAndCollect(
      ws,
      connector.reply(
        { target: onebotC2cTarget(12345), seq: 1, kind: 'final' },
        { text: '', attachments: [{ kind: 'file', absPath: c2cFile, fileName: 'page.html', sizeBytes: 7 }] },
      ),
      1,
    );
    expect(c2cActions[0]!['action']).toBe('upload_private_file');
    const c2cParams = c2cActions[0]!['params'] as { user_id: number; name: string };
    expect(c2cParams.user_id).toBe(12345);
    expect(c2cParams.name).toBe('page.html');
  });

  it('fileTransport=path 时直接传绝对路径（同机部署优化）', async () => {
    const { connector: c } = makeConnector(0, { fileTransport: 'path' });
    connector = c;
    await connector.start();
    const address = (connector as unknown as { server: { address: () => { port: number } } }).server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    const absPath = await makeAttachmentFile('pic.png', 'fake-png-bytes');
    const actions = await replyAndCollect(
      ws,
      connector.reply(
        { target: onebotGroupTarget(8888), seq: 1, kind: 'final' },
        { text: '', attachments: [{ kind: 'image', absPath, fileName: 'pic.png', sizeBytes: 14 }] },
      ),
      1,
    );
    const params = actions[0]!['params'] as { message: Array<{ data: { file: string } }> };
    expect(params.message[0]!.data.file).toBe(absPath);
  });
});
