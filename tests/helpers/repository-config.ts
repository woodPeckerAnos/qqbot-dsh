import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../../src/config-file.js';

/** 默认配置检查排除部署者的 ignored 本机文件，保留真实 include 加载。 */
export function loadRepositoryConfigFile() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-repository-config-'));
  try {
    copyFileSync(join(root, 'qqbot.yml'), join(dir, 'qqbot.yml'));
    cpSync(join(root, 'config'), join(dir, 'config'), {
      recursive: true,
      filter: (source) => basename(source) !== 'local',
    });
    return loadConfigFile({ QQ_CONFIG_FILE: join(dir, 'qqbot.yml') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
