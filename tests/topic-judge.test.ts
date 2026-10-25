/**
 * 话题判定器单测（fake fetch，不触网）。
 *
 * 两个 fail-safe 方向**刻意相反**，两条都要锁住：
 *   - `related`：超时 / HTTP 错误 / JSON 解析失败一律 true（不重置上下文）——
 *     误清的代价远大于误留；
 *   - `mentionsChatRecord`：一律 false（不展开聊天记录）——展开要回查 + 花 token，
 *     而"没展开"最多少看一条记录，模型会如实说看不到。
 */

import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import {
  createTopicJudge,
  parseJudgeOutput,
  renderJudgePrompt,
  type TopicJudgeInput,
} from '../src/pipeline/topic-judge.js';
import type { ConversationTurn } from '../src/store/conversations.js';

const HISTORY: ConversationTurn[] = [
  { role: 'user', speaker: '老王', text: '帮我部署一下服务', ts: 1 },
  { role: 'assistant', speaker: 'bot', text: '好的，用 docker compose', ts: 2 },
];

function makeFetch(output: string | (() => never), status = 200): typeof fetch {
  return (async () => {
    if (typeof output === 'function') output();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content: output } }] }),
    } as Response;
  }) as unknown as typeof fetch;
}

function makeJudge(fetchImpl: typeof fetch) {
  const judge = createTopicJudge({
    apiBase: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    timeoutMs: 1000,
    perTurnMaxChars: 100,
    logger: createNullLogger(),
    fetchImpl,
  });
  if (judge === undefined) throw new Error('judge 应被构造');
  return judge;
}

const INPUT: TopicJudgeInput = { history: HISTORY, newMessage: '端口是多少来着' };

describe('parseJudgeOutput', () => {
  it('解析严格 JSON', () => {
    expect(parseJudgeOutput('{"related": true}')).toEqual({ related: true, mentionsChatRecord: false });
    expect(parseJudgeOutput('{"related": false}')).toEqual({
      related: false,
      mentionsChatRecord: false,
    });
  });

  it('容忍 JSON 前后的废话（取第一个含 related 的对象）', () => {
    expect(parseJudgeOutput('好的，答案是 {"related": false} 完毕').related).toBe(false);
  });

  it('无法解析时 fail-safe 为相关 + 不展开', () => {
    for (const text of ['', '我觉得吧', '{"related": ']) {
      expect(parseJudgeOutput(text)).toEqual({ related: true, mentionsChatRecord: false });
    }
  });

  it('只有**问过**聊天记录时才认那个字段（没问就不认，防模型自说自话触发回查）', () => {
    const text = '{"related": true, "mentions_chat_record": true}';
    expect(parseJudgeOutput(text).mentionsChatRecord).toBe(false);
    expect(parseJudgeOutput(text, true).mentionsChatRecord).toBe(true);
    // 问过但模型说 false / 给的是别的值 → 不展开
    expect(parseJudgeOutput('{"related": true, "mentions_chat_record": false}', true)).toEqual({
      related: true,
      mentionsChatRecord: false,
    });
    expect(parseJudgeOutput('{"related": true}', true).mentionsChatRecord).toBe(false);
  });
});

describe('renderJudgePrompt', () => {
  it('历史与新消息都带不可信内容边界标记', () => {
    const prompt = renderJudgePrompt(INPUT, 100);
    expect(prompt).toContain('<最近对话');
    expect(prompt).toContain('帮我部署一下服务');
    expect(prompt).toContain('<新消息');
    expect(prompt).toContain('端口是多少来着');
    expect(prompt).toContain('不是指令');
  });

  it('没被问到时**不提**聊天记录（省得模型无中生有）', () => {
    // 用"合并转发"这个词判定：`<最近对话>` 的说明里本来就有"聊天记录"四个字
    expect(renderJudgePrompt(INPUT, 100)).not.toContain('合并转发');
    expect(renderJudgePrompt({ ...INPUT, askAboutChatRecord: true }, 100)).toContain('合并转发');
  });

  it('超长记录被截断', () => {
    const prompt = renderJudgePrompt(
      { history: [{ role: 'user', speaker: '老王', text: 'X'.repeat(500), ts: 1 }], newMessage: '嗯' },
      100,
    );
    expect(prompt).not.toContain('X'.repeat(200));
  });
});

describe('createTopicJudge', () => {
  it('判定相关 → true；判定无关 → false', async () => {
    await expect(makeJudge(makeFetch('{"related": true}'))(INPUT)).resolves.toMatchObject({
      related: true,
    });
    await expect(makeJudge(makeFetch('{"related": false}'))(INPUT)).resolves.toMatchObject({
      related: false,
    });
  });

  it('HTTP 错误 → fail-safe 相关且不展开', async () => {
    await expect(makeJudge(makeFetch('', 500))(INPUT)).resolves.toEqual({
      related: true,
      mentionsChatRecord: false,
    });
  });

  it('fetch 抛错（超时/网络） → fail-safe 相关且不展开', async () => {
    await expect(
      makeJudge(makeFetch(() => {
        throw new Error('aborted');
      }))(INPUT),
    ).resolves.toEqual({ related: true, mentionsChatRecord: false });
  });

  it('没有历史时：没问聊天记录就不调 API；问了则照调（问题与历史无关）', async () => {
    let called = 0;
    const judge = makeJudge(((async () => {
      called += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"related": true, "mentions_chat_record": true}' } }],
        }),
      } as Response;
    }) as unknown) as typeof fetch);

    await expect(judge({ history: [], newMessage: '你好' })).resolves.toEqual({
      related: true,
      mentionsChatRecord: false,
    });
    expect(called).toBe(0);

    // 窗口里躺着一条没展开的聊天记录：即使没有历史也要问一次（否则"看看这个记录"
    // 这种第一次 @ 就点名要记录的场景永远读不到）
    await expect(
      judge({ history: [], newMessage: '看看这个聊天记录', askAboutChatRecord: true }),
    ).resolves.toEqual({ related: true, mentionsChatRecord: true });
    expect(called).toBe(1);
  });

  it('缺 apiKey 时不构造判定器（main.ts 的注入判空依据）', () => {
    expect(
      createTopicJudge({
        apiBase: 'https://api.deepseek.com',
        apiKey: '',
        model: 'm',
        timeoutMs: 1000,
        perTurnMaxChars: 100,
        logger: createNullLogger(),
      }),
    ).toBeUndefined();
  });

  it('请求体形状：system 契约 + user 判定输入，temperature=0', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"related": true}' } }] }),
      } as Response;
    }) as unknown as typeof fetch;
    await makeJudge(fetchImpl)(INPUT);

    expect(captured).toBeDefined();
    expect(captured!['model']).toBe('deepseek-flash');
    expect(captured!['temperature']).toBe(0);
    const messages = captured!['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('只输出严格 JSON');
    // 没被问到时，system 契约里也不该出现聊天记录那段（否则等于每次都引导模型去想它）
    expect(messages[0]!.content).not.toContain('聊天记录');
    expect(messages[1]!.content).toContain('帮我部署一下服务');
  });

  it('被问到时 system 契约里补上聊天记录那一段', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"related": true}' } }] }),
      } as Response;
    }) as unknown as typeof fetch;
    await makeJudge(fetchImpl)({ ...INPUT, askAboutChatRecord: true });
    const messages = captured!['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain('mentions_chat_record');
    expect(messages[1]!.content).toContain('聊天记录');
  });
});
