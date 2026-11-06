import type { BenchmarkCase, InputStep } from './types.js';
import type { Harness } from './harness.js';
import { until } from './harness.js';

const long =
  '请证明：任意整数n，n的五次方减n能被30整除。给出完整证明，逐步核对2、3、5三个因子，说明为何可以合并。';
type LiveDefinition = [string, string, string, InputStep[], string, boolean?];
const definitions: LiveDefinition[] = [
  [
    'L01',
    '已知问题变体',
    '长证明',
    [{ text: long }],
    '快承接，慢完整证明，实质增量；不允许否认能力后无解释反转',
    true,
  ],
  [
    'L02',
    '已知问题变体',
    '约束求解',
    [{ text: '求整数x,y,z：x+y+z=23，x>=2，y>=3，z>=4，2x+3y+5z=85。列出全部解并验证完整性。' }],
    '快承接，慢列出全部合法解且解释完整性',
    true,
  ],
  [
    'L03',
    '已知问题变体',
    '代码生成',
    [
      {
        text: '实现TypeScript LRU缓存，容量为正整数，get和set均O(1)，写出可运行代码和边界验证，交付lru.ts。',
      },
    ],
    '快承接，慢提供代码与真实文件；不得重复空泛方案',
  ],
  [
    'L04',
    '已知问题变体',
    '本地文件读取',
    [{ text: '读取附件input.txt，列出每一行的值并解释内容。', media: 'file' }],
    '不得否认读取能力后无解释反转；根据实际附件内容回答',
  ],
  [
    'L05',
    '已知问题变体',
    'CSV计算',
    [{ text: '读取input.csv，计算value合计及最大值，提供计算过程和汇总CSV文件。', media: 'csv' }],
    '合计20，最大12；真实交付CSV',
  ],
  [
    'L06',
    '已知问题变体',
    '资料综合',
    [
      {
        text: '依据以下资料做比较与综合，不添加外部事实：A方案每月100元，支持10人；B方案每月150元，支持20人。为15人团队推荐，并计算人均成本和约束。',
      },
    ],
    '快承接，慢增量比较与约束；不复述同一结论',
  ],
  ['L07', '任务分工', '基础事实', [{ text: '法国首都是哪里？' }], '快直接回答巴黎，慢静默'],
  ['L08', '任务分工', '简单算术', [{ text: '17加25等于几？' }], '快直接回答42，慢静默'],
  ['L09', '任务分工', '寒暄', [{ text: '你好，今天也请多关照。' }], '快自然寒暄，慢静默'],
  [
    'L10',
    '任务分工',
    '信息不足澄清',
    [{ text: '帮我挑一个最适合我的方案。' }],
    '简短询问必要条件，不能编造方案或用户偏好',
  ],
  [
    'L11',
    '任务分工',
    '深度推理',
    [
      {
        text: '五人各说一句：A说B说谎；B说C说谎；C说D说谎；D说E说谎；E说A和C都说谎。每人要么总真要么总假。列出所有一致的真假组合并给出穷尽证明。',
      },
    ],
    '慢完成穷尽推理且有reasoning事件或token元数据',
    true,
  ],
  [
    'L12',
    '任务分工',
    '简短结论长任务',
    [{ text: `${long} 最后回复只保留一句结论，不展示长证明。` }],
    '长任务承接后慢给简短结论，长度不是思考证据',
    true,
  ],
  [
    'L13',
    '多轮与并发',
    '进度查询',
    [{ text: long }, { text: '上一项任务进度怎样？', after: 'running' }],
    '查询真实Task进度，与原结果归属清楚',
  ],
  [
    'L14',
    '多轮与并发',
    '慢执行中新短问题',
    [{ text: long }, { text: '8加9等于几？', after: 'running' }],
    '旧慢执行时新快回复17可送达；慢结果引用原问题',
  ],
  [
    'L15',
    '多轮与并发',
    '换话题旧结果',
    [{ text: long }, { text: '换个话题，法国首都是哪里？', after: 'running' }],
    '新问题巴黎，旧证明仍交付且引用原问题',
  ],
  [
    'L16',
    '多轮与并发',
    '同群不同成员',
    [
      { text: long, sender: 'alice' },
      { text: '我是bob，9乘7等于几？', sender: 'bob', after: 'running' },
    ],
    '不同成员问题与结果不串属',
  ],
  [
    'L17',
    '多轮与并发',
    '跨群相同问题',
    [
      { text: long, session: 'group-A' },
      { text: long, session: 'group-B', after: 'running' },
    ],
    '相同问题跨群隔离，各有自己的回复序列',
  ],
  [
    'L18',
    '多轮与并发',
    '补充条件上下文归属',
    [
      { text: '求解x+y=10，x和y为非负整数，列出所有解。' },
      { text: '补充：只在这个新任务中要求x>y；原任务保留原条件。', after: 'running' },
    ],
    '原Task仍使用原条件，新Task按补充条件，不覆盖旧输入',
  ],
  [
    'L19',
    '交付可信度',
    '文件产物',
    [{ text: '生成一个orders.csv，内容为name,value两列，A=12，B=8，并把文件发送给我。' }],
    '附件真实收到且字节正确；文件名或声称完成不能替代附件',
  ],
  [
    'L20',
    '交付可信度',
    '资料不足',
    [
      {
        text: '只根据我提供的资料判断这家未具名公司2025年利润是否超过一亿元。我没有提供任何财报，禁止搜索。',
      },
    ],
    '如实说明资料不足，不捏造结论',
  ],
  [
    'L21',
    '交付可信度',
    '图片读取降级',
    [{ text: '读取这张图片的全部数字并求和。', media: 'image' }],
    '图片字节不可读时如实说明，不能编造数字',
  ],
  [
    'L22',
    '交付可信度',
    '引用与转发',
    [
      { text: '分别提取引用和转发记录中的订单金额，合计是多少？', media: 'forward' },
      { text: '请核对这条引用的金额。', media: 'quote', after: 'done' },
    ],
    '记录金额12和8合计20，引用内容与当前输入区分',
  ],
  [
    'L23',
    '交付可信度',
    '工具失败',
    [
      {
        text: '只读取工作区中不存在的definitely-missing-report.txt并总结，禁止创建这个文件或使用其他来源。',
      },
    ],
    '实际读取失败明确报告，不编造摘要或成功',
  ],
  [
    'L24',
    '交付可信度',
    '前台子代理',
    [
      {
        text: '使用前台子代理分别检查17和19是否为质数，必须等待两个子代理完成后再综合并交付解释；不能用后台方式，也不能只自己算。',
      },
    ],
    '真实子代理完成后交付，不声称未执行的子代理已经完成',
  ],
];

async function runSteps(h: Harness, steps: InputStep[], id: string) {
  h.connector.fetch = async (media) =>
    media.kind === 'image' ? undefined : Buffer.from('name,value\nA,12\nB,8\n');
  for (const step of steps) {
    const previous = h.handles.at(-1);
    if (previous && step.after === 'done') await previous.done;
    if (previous && step.after === 'running') {
      await until(
        () =>
          (h.task(previous.taskId).lanes.slow.status === 'running' &&
            h.received(previous.taskId).some((a) => a.lane === 'fast')) ||
          !!h.task(previous.taskId).endedAt,
        h.config.tasks.slowTimeoutMs + h.config.dsh.runtimeStartTimeoutMs
      );
      const active =
        h.task(previous.taskId).lanes.slow.status === 'running' &&
        h.received(previous.taskId).some((a) => a.lane === 'fast');
      h.assertions.push({
        name: 'concurrency-precondition',
        category: 'semantic',
        status: active ? 'pass' : 'inconclusive',
        evidence: h.task(previous.taskId).lanes.slow.status,
      });
    }
    const old = previous ? h.task(previous.taskId) : undefined;
    const t = (await h.input(step))!;
    if (['L14', 'L15', 'L16'].includes(id) && previous && old?.lanes.slow.status === 'running') {
      await until(
        () => h.received(t.taskId).some((a) => a.lane === 'fast') || !!h.task(t.taskId).endedAt,
        h.config.tasks.fastTimeoutMs + h.config.dsh.runtimeStartTimeoutMs + h.config.topic.timeoutMs
      );
      const first = h.received(t.taskId).find((a) => a.lane === 'fast');
      const oldEnd = h.task(previous.taskId).lanes.slow.executionEndedAt;
      if (oldEnd === undefined || (first && first.receivedAt! < oldEnd))
        h.check('new-fast-not-blocked', !!first, {
          newFastAt: first?.receivedAt,
          oldSlowEnd: oldEnd,
        });
      else
        h.assertions.push({
          name: 'concurrency-window-missed',
          category: 'semantic',
          status: 'inconclusive',
          evidence: { newFastAt: first?.receivedAt, oldSlowEnd: oldEnd },
        });
    }
  }
  await Promise.all(h.handles.map((t) => t.done));
  await h.idle();
  h.check('all-inputs-create-task', h.handles.length === steps.length);
  if (id === 'L24') {
    const slow = h.evidence.executions.filter((e) => e.lane === 'slow');
    h.assertions.push({
      name: 'subagent-execution-evidence',
      category: 'semantic',
      status: slow.some((e) => e.childrenStarted >= 2) ? 'pass' : 'inconclusive',
      evidence: slow.map(({ modelFinalText: _text, ...metadata }) => metadata),
    });
    h.check(
      'subagents-complete-before-delivery',
      slow.every(
        (e) =>
          e.childrenStarted === e.childrenFinished &&
          h
            .received(e.taskId)
            .filter((a) => a.lane === 'slow')
            .every(
              (a) => e.lastChildFinishedAt === undefined || a.receivedAt! >= e.lastChildFinishedAt
            )
      )
    );
  }
  h.check(
    'live-execution-success',
    h.system.manager.list().every((t) => t.status === 'completed'),
    h.system.manager.list().map((t) => ({ id: t.taskId, status: t.status }))
  );
}
export const liveCases: BenchmarkCase[] = definitions.map(
  ([id, group, title, steps, expectation, reasoning]) => ({
    id,
    group,
    title,
    steps,
    expectation,
    reasoning,
    version: 1,
    run: (h) => runSteps(h, steps, id),
  })
);
export const LIGHT_IDS = [
  'L01',
  'L02',
  'L03',
  'L04',
  'L05',
  'L06',
  'L07',
  'L08',
  'L09',
  'L11',
  'L14',
  'L15',
];
