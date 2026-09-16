import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { admitScenarioPack } from '../../public/src/admission.mjs';

// Bound input before any lab allocation. Never follow a symlink or read a device.
export async function readScenarioFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new Error('SCENARIO_FILE_INVALID');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.size > 131072 || actual.ino !== info.ino || actual.dev !== info.dev) throw new Error('SCENARIO_FILE_INVALID');
    const bytes = Buffer.alloc(131073);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > 131072) throw new Error('SCENARIO_FILE_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    const { scenario } = await admitScenarioPack(text);
    return scenario;
  } finally { await file.close(); }
}
