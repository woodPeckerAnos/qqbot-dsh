/**
 * 长任务提示注入单测（pipeline/hints.ts，纯函数，全离线）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LONG_TASK_PATTERNS,
  matchLongTaskHint,
} from '../src/pipeline/hints.js';

describe('matchLongTaskHint', () => {
  it('命中默认关键词', () => {
    expect(matchLongTaskHint('帮我核查一下这个新闻是不是真的', DEFAULT_LONG_TASK_PATTERNS)).toBe(true);
    expect(matchLongTaskHint('批量把这些文件转成 pdf', DEFAULT_LONG_TASK_PATTERNS)).toBe(true);
  });

  it('普通闲聊不命中', () => {
    expect(matchLongTaskHint('今天天气怎么样', DEFAULT_LONG_TASK_PATTERNS)).toBe(false);
    expect(matchLongTaskHint('1+1 等于几', DEFAULT_LONG_TASK_PATTERNS)).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchLongTaskHint('帮我 Fetch 这个页面', ['fetch'])).toBe(true);
  });

  it('空 patterns = 永不命中', () => {
    expect(matchLongTaskHint('核查这个', [])).toBe(false);
  });
});
