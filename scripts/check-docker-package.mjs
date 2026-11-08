/** Verify the exact Docker workspace layout without invoking the production entry. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'qqbot-docker-package-'));
mkdirSync(join(root, 'packages/contracts'), { recursive: true });
cpSync('package.json', join(root, 'package.json'));
cpSync('dist', join(root, 'dist'), { recursive: true });
cpSync('packages/contracts/package.json', join(root, 'packages/contracts/package.json'));
cpSync('packages/contracts/dist', join(root, 'packages/contracts/dist'), { recursive: true });
mkdirSync(join(root, 'node_modules/@qqbot'), { recursive: true });
symlinkSync('../../packages/contracts', join(root, 'node_modules/@qqbot/contracts'));
for (const [name] of Object.entries(
  JSON.parse(readFileSync('package.json', 'utf8')).dependencies
)) {
  if (name === '@qqbot/contracts') continue;
  if (name.startsWith('@'))
    mkdirSync(join(root, 'node_modules', name.split('/')[0]), { recursive: true });
  symlinkSync(resolve('node_modules', name), join(root, 'node_modules', name));
}
const dockerfile = readFileSync('Dockerfile', 'utf8');
assert.match(dockerfile, /COPY packages\/contracts\/package\.json/u);
assert.match(dockerfile, /COPY --from=build[^\n]*\/app\/packages\/contracts/u);
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
import assert from 'node:assert/strict';
import { LANES, readonlySnapshot } from '@qqbot/contracts';
assert.deepEqual(LANES, ['fast', 'slow']);
assert(Object.isFrozen(readonlySnapshot({ nested: { value: 1 } })));
for (const id of ['config','content','connectors','store','media','runtime','task','session','delivery','ingress','proactive','offpeak','observability']) await import('./dist/' + id + '/index.js');
`,
  ],
  { cwd: root, stdio: 'inherit' }
);
console.log('Docker 运行阶段的 workspace 相对链接、契约产物与 13 个模块均可解析。');
