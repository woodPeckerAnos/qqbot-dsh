import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/ 是集成面；src/intervention/rules/ 下的单测与规则文件夹自包含
    // （规则 = 需求 + 实现 + 单测，见 docs/TOPIC-INTERVENTION-PLAN.md §5.2）。
    include: ['tests/**/*.test.ts', 'src/intervention/rules/**/*.test.ts'],
    // _rejected/ 是生成器的拒绝留档区——里面的代码没通过校验，不参与测试/构建
    exclude: ['**/node_modules/**', '**/dist/**', '**/_rejected/**'],
    environment: 'node',
    // 全部单测必须离线可跑：不触网、不起 DSH 子进程。
    testTimeout: 15_000,
  },
});
