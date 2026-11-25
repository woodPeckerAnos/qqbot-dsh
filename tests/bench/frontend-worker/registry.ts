import type { RegistryEntry } from './report.js';
import { productionGroups } from './production-groups.js';
export const registry: RegistryEntry[] = [
  {
    id: 'F01',
    name: '普通请求 worker 为零',
    requiredChecks: [
      '普通请求仅运行一次前台',
      '最终回复保存并确认入队',
      '正文引用原消息且只送达一次',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F02',
    name: '长任务与前台新输入交错',
    requiredChecks: [
      'worker 未结束时新普通请求已完成',
      '进度关联原 Task 且不创建新 worker',
      '结果交回前台整理一次',
      '业务内部正文未直接发送',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F03',
    name: '两次整理失败保留结果',
    requiredChecks: [
      '整理最多两次且 worker 只运行一次',
      '失败终态保留完整业务结果',
      '整理失败说明送达，原业务正文不直接发出',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F04',
    name: '多会话容量上限',
    requiredChecks: [
      '最多四个 worker 执行，其余六个排队',
      '运行总量不超过八个，全部首次前台已保存结束状态',
      '十个任务均完成且峰值始终不超限',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F05',
    name: '跨会话公平与会话内串行',
    requiredChecks: [
      '忙会话只运行一个 worker，其他会话先完成',
      '被阻塞会话仍按顺序完成全部 worker',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F06',
    name: '执行 worker 取消',
    requiredChecks: [
      '取消已开始 worker 被接受',
      '取消终态不启动整理或再次执行 worker',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F07',
    name: 'stop 保留首次前台排队任务',
    requiredChecks: [
      'stop 只取消已经开始的 Task',
      '未开始首次前台的输入保留并完成',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F08',
    name: '首次前台与结果整理交替',
    requiredChecks: [
      '首次输入与结果整理同时排队',
      '首次前台、整理、首次前台按顺序交替',
      '排队的普通请求和结果全部完成，无额外 worker',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F09',
    name: '固定回复与独立附件持久交付',
    requiredChecks: [
      '执行完成与等待送达状态分开，附件已保存独立副本',
      '任务清理保留固定消息，不再次调用 worker 或整理',
      '原文件删除后附件完整送达一次',
      '关闭后执行、排队和计时器全部释放',
    ],
    coverage: {
      realTaskSystem: true,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
];
registry.find((entry) => entry.id === 'F09')!.coverage.adapter = true;
registry.push(...productionGroups);
