/**
 * 话题判定器单测（fake fetch，不触网）。
 *
 * 核心不变量：**fail-safe = 相关**。超时、HTTP 错误、JSON 解析失败一律
 * 返回 true（不重置上下文）——误清的代价远大于误留。
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
    expect(parseJudgeOutput('{"related": true}')).toBe(true);
    expect(parseJudgeOutput('{"related": false}')).toBe(false);
  });

  it('容忍 JSON 前后的废话（取第一个含 related 的对象）', () => {
    expect(parseJudgeOutput('好的，答案是 {"related": false} 完毕')).toBe(false);
  });

  it('无法解析时 fail-safe 为相关', () => {
    expect(parseJudgeOutput('')).toBe(true);
    expect(parseJudgeOutput('我觉得吧')).toBe(true);
    expect(parseJudgeOutput('{"related": ')).toBe(true);
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
    await expect(makeJudge(makeFetch('{"related": true}'))(INPUT)).resolves.toBe(true);
    await expect(makeJudge(makeFetch('{"related": false}'))(INPUT)).resolves.toBe(false);
  });

  it('HTTP 错误 → fail-safe 相关', async () => {
    await expect(makeJudge(makeFetch('', 500))(INPUT)).resolves.toBe(true);
  });

  it('fetch 抛错（超时/网络） → fail-safe 相关', async () => {
    await expect(
      makeJudge(makeFetch(() => {
        throw new Error('aborted');
      }))(INPUT),
    ).resolves.toBe(true);
  });

  it('没有历史时不调用 API，直接相关（没有可重置的上下文）', async () => {
    let called = 0;
    const judge = makeJudge(((async () => {
      called += 1;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown) as typeof fetch);
    await expect(judge({ history: [], newMessage: '你好' })).resolves.toBe(true);
    expect(called).toBe(0);
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
    expect(messages[1]!.content).toContain('帮我部署一下服务');
  });
});
