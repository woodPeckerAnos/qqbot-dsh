import { defineConfig } from 'vitest/config';

const files: unknown = JSON.parse(process.env.TASKS_V3_EVIDENCE_FILES ?? '[]');
if (
  !Array.isArray(files) ||
  !files.length ||
  !files.every((file) => typeof file === 'string' && /^tests\/[\w/-]+\.test\.ts$/.test(file))
)
  throw new Error('必须由V3 benchmark传入明确生产测试文件');
export default defineConfig({
  test: { include: files, environment: 'node', fileParallelism: false, testTimeout: 15_000 },
});
