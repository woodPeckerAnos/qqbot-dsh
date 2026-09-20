/**
 * 分段与渲染单测。
 *
 * 这层直接决定"机器人会不会因为消息太长而报 40054007"，以及
 * "会不会不小心 at 了全群的人"，都值得测。
 */

import { describe, expect, it } from 'vitest';

import { segmentText } from '../src/pipeline/chunk.js';
import {
  defuseMentions,
  messageTextLength,
  normalizeWhitespace,
  renderMessage,
  stripControlChars,
  toPlainText,
} from '../src/pipeline/markdown.js';

describe('segmentText', () => {
  it('短文本不切分', () => {
    const result = segmentText('短内容', { maxChars: 100, maxSegments: 3 });
    expect(result.segments).toEqual(['短内容']);
    expect(result.truncated).toBe(false);
  });

  it('空文本返回空数组', () => {
    expect(segmentText('   ', { maxChars: 100, maxSegments: 3 }).segments).toEqual([]);
  });

  it('在段落边界切分，不切在段落中间，且不留空行', () => {
    const para1 = 'A'.repeat(50);
    const para2 = 'B'.repeat(50);
    const para3 = 'C'.repeat(50);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    // 上限 110：前两段合计 102 字符放得下，所以第一段应是"段1+段2"，而不是"段1"
    const result = segmentText(text, { maxChars: 110, maxSegments: 5 });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toBe(`${para1}\n\n${para2}`);
    expect(result.segments[1]).toBe(para3);
    // 关键性质：每段结尾不带空行、开头不带空行
    for (const segment of result.segments) {
      expect(segment).toBe(segment.trim());
    }
    // 内容无丢失
    expect(result.segments.join('\n\n')).toBe(text);
  });

  it('一段刚好放不下时，退回切在段落边界而不是切在段落中间', () => {
    const para1 = 'A'.repeat(50);
    const para2 = 'B'.repeat(50);
    const text = `${para1}\n\n${para2}`;
    // 上限 80：装不下两段（102），应切在段落边界
    const result = segmentText(text, { maxChars: 80, maxSegments: 5 });
    expect(result.segments).toEqual([para1, para2]);
  });

  it('每段长度不超过上限', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 行：${'x'.repeat(30)}`).join('\n');
    const result = segmentText(text, { maxChars: 200, maxSegments: 20 });
    for (const segment of result.segments) {
      expect(segment.length).toBeLessThanOrEqual(200);
    }
  });

  it('段数用尽时截断并标记', () => {
    const text = 'A'.repeat(1000);
    const result = segmentText(text, { maxChars: 100, maxSegments: 3 });
    expect(result.segments).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // 最后一段应带截断提示
    expect(result.segments[2]).toMatch(/已截断/);
  });

  it('切分不破坏代码围栏：每段自身围栏成对', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line_${i} = ${i}`).join('\n');
    const text = `说明如下：\n\n\`\`\`python\n${code}\n\`\`\`\n\n结束。`;
    const result = segmentText(text, { maxChars: 120, maxSegments: 10 });

    for (const segment of result.segments) {
      const fences = (segment.match(/```/g) ?? []).length;
      // 每段要么没有围栏，要么围栏成对（允许含语言标记的开启行）
      expect(fences % 2).toBe(0);
    }
    // 至少有一段位于代码块内部，验证确实跨围栏切分了
    expect(result.segments.length).toBeGreaterThan(1);
  });

  it('maxSegments 为 0 时不返回内容但标记截断', () => {
    const result = segmentText('内容', { maxChars: 10, maxSegments: 0 });
    expect(result.segments).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});

describe('文本清洗', () => {
  it('剥离控制字符但保留换行与制表', () => {
    expect(stripControlChars('a\u0000b\u0007c\nd\te')).toBe('abc\nd\te');
  });

  it('折叠过多空行并去行尾空白', () => {
    expect(normalizeWhitespace('a   \n\n\n\nb')).toBe('a\n\nb');
  });

  it('打断 @ 语义，避免机器人替人 at 全群', () => {
    const result = defuseMentions('@所有人 请注意 @张三');
    expect(result).not.toBe('@所有人 请注意 @张三');
    expect(result).toMatch(/@\u200d/);
    // 视觉上仍然可读
    expect(result.replace(/\u200d/g, '')).toBe('@所有人 请注意 @张三');
  });

  it('纯文本模式剥离 Markdown 标记', () => {
    const md = [
      '# 标题',
      '',
      '**粗体** 与 *斜体* 与 `代码`',
      '',
      '> 引用',
      '',
      '[链接](https://example.com)',
    ].join('\n');
    const plain = toPlainText(md);
    expect(plain).not.toContain('#');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`');
    expect(plain).not.toContain('> ');
    expect(plain).toContain('标题');
    expect(plain).toContain('粗体');
    expect(plain).toContain('链接 (https://example.com)');
  });

  it('代码围栏内的代码内容被保留', () => {
    const plain = toPlainText('```python\nprint(1)\n```');
    expect(plain).toContain('print(1)');
    expect(plain).not.toContain('```');
  });
});

describe('renderMessage', () => {
  it('纯文本模式设置 content 而不是 markdown', () => {
    const body = renderMessage('**hi**', {
      msgType: 0,
      groupOpenid: 'g1',
      msgId: 'm1',
      msgSeq: 1,
    });
    expect(body.msg_type).toBe(0);
    expect(body.content).toBe('hi');
    expect(body.markdown).toBeUndefined();
    expect(body.msg_id).toBe('m1');
    expect(body.msg_seq).toBe(1);
  });

  it('markdown 模式设置 markdown.content', () => {
    const body = renderMessage('## 标题', {
      msgType: 2,
      groupOpenid: 'g1',
      msgId: 'm1',
      msgSeq: 2,
    });
    expect(body.msg_type).toBe(2);
    expect(body.markdown?.content).toContain('## 标题');
    expect(body.content).toBeUndefined();
  });

  it('msg_id 与 event_id 互斥：同时给出时优先 msg_id', () => {
    const body = renderMessage('hi', {
      msgType: 0,
      groupOpenid: 'g1',
      msgId: 'm1',
      eventId: 'e1',
      msgSeq: 1,
    });
    expect(body.msg_id).toBe('m1');
    expect(body.event_id).toBeUndefined();
  });

  it('只有 event_id 时使用 event_id', () => {
    const body = renderMessage('hi', {
      msgType: 0,
      groupOpenid: 'g1',
      eventId: 'e1',
      msgSeq: 1,
    });
    expect(body.event_id).toBe('e1');
    expect(body.msg_id).toBeUndefined();
  });

  it('quoteMessageId 生成 message_reference', () => {
    const body = renderMessage('hi', {
      msgType: 0,
      groupOpenid: 'g1',
      msgId: 'm1',
      msgSeq: 1,
      quoteMessageId: 'prev',
    });
    expect(body.message_reference).toEqual({ message_id: 'prev' });
  });

  it('messageTextLength 按模式取对应字段长度', () => {
    expect(messageTextLength({ msg_type: 0, content: 'abcd' })).toBe(4);
    expect(messageTextLength({ msg_type: 2, markdown: { content: 'ab' } })).toBe(2);
  });
});
