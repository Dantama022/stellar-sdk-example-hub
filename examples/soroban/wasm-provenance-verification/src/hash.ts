import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export class ArtifactError extends Error {
  constructor(public readonly code: 'MISSING' | 'NOT_A_FILE' | 'UNREADABLE', message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export function sha256Buffer(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stream a file through SHA-256 so large WASM files are never fully held in memory. */
export async function sha256File(file: string): Promise<string> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new ArtifactError('NOT_A_FILE', `${file} is not a file`);
  } catch (err) {
    if (err instanceof ArtifactError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new ArtifactError(code === 'ENOENT' ? 'MISSING' : 'UNREADABLE', code === 'ENOENT' ? `artifact not found: ${file}` : `cannot access ${file}: ${(err as Error).message}`);
  }
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', (err) => reject(new ArtifactError('UNREADABLE', `cannot read ${file}: ${err.message}`)))
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
