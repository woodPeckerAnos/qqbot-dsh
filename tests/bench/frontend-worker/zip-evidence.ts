import { createHash } from 'node:crypto';

export interface ArchiveEntryEvidence {
  name: string;
  sizeBytes: number;
  sha256: string;
}
export function deliveredArchiveMatches(
  actual: readonly ArchiveEntryEvidence[],
  expected: readonly ArchiveEntryEvidence[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (entry, index) =>
        entry.name === expected[index]?.name &&
        entry.sizeBytes === expected[index]?.sizeBytes &&
        entry.sha256 === expected[index]?.sha256
    )
  );
}

/** The production archive writer uses stored ZIP entries; validate their actual bytes. */
export function readStoredZip(
  bytes: Buffer
): { name: string; sizeBytes: number; sha256: string; text: string }[] {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (bytes.readUInt16LE(offset + 8) !== 0) throw new Error('benchmark仅接受生产stored ZIP');
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    if (start + size > bytes.length) throw new Error('ZIP条目越界');
    const data = bytes.subarray(start, start + size);
    entries.push({
      name: bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'),
      sizeBytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      text: data.toString('utf8'),
    });
    offset = start + size;
  }
  if (!entries.length || offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
    throw new Error('ZIP缺少有效目录');
  return entries;
}
