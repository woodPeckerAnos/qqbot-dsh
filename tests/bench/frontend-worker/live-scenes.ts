export interface LiveScene {
  id: string;
  name: string;
  steps: readonly string[];
  requiredChecks: readonly string[];
}
export const liveScenes: readonly LiveScene[] = [
  {
    id: 'L01',
    name: '搜索失败后闲聊及明确重试',
    steps: [
      '请联网搜索最新的中国空间站发射新闻并列出三个可信来源。搜索服务若额度耗尽请停止并明确说明，禁止用bash或抓取补搜。',
      '好吧，先聊点别的，你好呀。',
      '明确重试刚才失败的搜索任务一次，仍沿用搜索工具，不换其他搜索途径。',
    ],
    requiredChecks: [
      '首次实际调用搜索',
      '失败后闲聊不新增worker',
      '明确重试授权绑定旧Task',
      '额度缓存保留首次错误且重试不新增worker',
      '首次额度错误后不新增搜索HTTP',
    ],
  },
  {
    id: 'L02',
    name: '查询已保存结果及投递状态',
    steps: [
      '用本地工具计算12+8，完成后给我计算结果和依据，不需要文件。',
      '刚才那项任务的结果和送达情况怎么样？请先查询已保存任务。',
    ],
    requiredChecks: ['前项实际创建worker', '后项实际调用任务查询', '后项不新增worker'],
  },
  {
    id: 'L03',
    name: '聊天正文与显式正文文件交付意图',
    steps: [
      '用本地工具写一份100字工作总结，outbox可以保存result.md备查；请直接在聊天里回复正文，不需要发送文件。',
      '再写一份100字总结，这次明确需要Markdown文件作为附件发送。',
    ],
    requiredChecks: ['聊天正文不发送正文文件', '显式文件请求实际送达正文文件'],
  },
];
