import { promises as fs } from 'fs';

export interface Checkpoint {
  version: 1;
  scope: string;
  cursor?: string;
}

export async function loadCheckpoint(file: string, scope: string): Promise<Checkpoint> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Checkpoint;
    if (
      value.version !== 1 ||
      value.scope !== scope ||
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor))
    ) {
      throw new Error('Checkpoint version, scope, or cursor mismatch');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, scope };
    throw new Error('Invalid checkpoint; inspect it or explicitly remove it to restart.');
  }
}

export async function saveCheckpoint(file: string, checkpoint: Checkpoint): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Retry only transient retrieval failures. Processing and checkpoint writes are never retried here. */
export async function retryRead<T>(
  read: () => Promise<T>,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const e = error as { response?: { status?: number }; code?: string; message?: string };
      const status = e.response?.status;
      const transient =
        status === 429 ||
        (status !== undefined && status >= 500) ||
        /timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(`${e.code} ${e.message}`);
      if (!transient || attempt >= 3)
        throw new Error('Retrieval failed; checkpoint preserved.', { cause: error });
      await sleep(500 * 2 ** attempt);
    }
  }
}

export interface ScanPage<T> {
  records: T[];
  cursor?: string;
}

export async function scan<T>(options: {
  checkpoint: Checkpoint;
  fetch: (cursor?: string) => Promise<ScanPage<T>>;
  identity: (record: T) => string;
  process: (record: T) => Promise<void>;
  save: (checkpoint: Checkpoint) => Promise<void>;
  maxPages: number;
}): Promise<void> {
  const seen = new Set<string>();
  let checkpoint = { ...options.checkpoint };
  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber++) {
    const page = await retryRead(() => options.fetch(checkpoint.cursor));
    if (!Array.isArray(page.records)) throw new Error('Malformed page');
    const batch = new Set<string>();
    for (const record of page.records) {
      const id = options.identity(record);
      if (!id) throw new Error('Missing stable record identifier');
      if (!seen.has(id) && !batch.has(id)) await options.process(record);
      batch.add(id);
    }
    if (!page.cursor || page.cursor === checkpoint.cursor) {
      if (page.records.length) throw new Error('Nonempty page did not advance cursor');
      return;
    }
    // Commit only after the entire batch succeeds. A crash may replay side effects.
    const next: Checkpoint = { ...checkpoint, cursor: page.cursor };
    await options.save(next);
    checkpoint = next;
    batch.forEach((id) => seen.add(id));
    if (!page.records.length) return;
  }
  console.log('Page budget reached; resume with the saved checkpoint.');
}
