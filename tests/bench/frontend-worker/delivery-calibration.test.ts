import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { packFiles } from '../../../src/media/index.js';
import { MemoryConnector } from '../session/connector.js';
import { OnebotProbe, digest } from '../session/onebot-probe.js';
import { deliveredArchiveMatches } from './zip-evidence.js';
import { recordBenchmarkEvidence } from './evidence.js';

it('真实OneBot送出的错误ZIP必须被正常文件完整性检查拒绝，正确ZIP通过同一检查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-calibration-'));
  const connector = new MemoryConnector();
  connector.recordCapable = true;
  const probe = new OnebotProbe(connector);
  await probe.start();
  const expected = [{ name: 'result.csv', sizeBytes: 8, sha256: digest('x,y\n1,2\n') }];
  try {
    const outcomes: boolean[] = [];
    for (const contents of ['x,y\n9,9\n', 'x,y\n1,2\n']) {
      const source = join(root, 'result.csv');
      await writeFile(source, contents);
      const bytes = await packFiles([{ absPath: source, fileName: 'result.csv' }]);
      const archive = join(root, 'result.zip');
      await writeFile(archive, bytes);
      await connector.reply(
        {
          target: { platform: 'onebot', kind: 'group', key: 'onebot:group:group', id: 'group' },
          kind: 'final',
          seq: 1,
        },
        {
          text: '',
          attachments: [
            { kind: 'file', absPath: archive, fileName: 'result.zip', sizeBytes: bytes.length },
          ],
        }
      );
      outcomes.push(deliveredArchiveMatches(probe.actions.at(-1)?.zipEntries ?? [], expected));
    }
    expect(outcomes).toEqual([false, true]);
    expect(probe.actions.map((action) => action.action)).toEqual([
      'upload_group_file',
      'upload_group_file',
    ]);
    await recordBenchmarkEvidence('delivery-negative-calibration', {
      outcomes,
      expected,
      actual: probe.actions.map((action) => ({
        payloadBytes: action.payloadBytes,
        entries: action.zipEntries,
      })),
    });
  } finally {
    await probe.stop();
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});
