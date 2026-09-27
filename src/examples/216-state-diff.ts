import fs from 'fs';

interface SnapshotEntry {
  ledgerKey: string;
  valueXdr: string;
  liveUntilLedgerSeq: number;
  [key: string]: any;
}

export async function run(params: { beforeFile?: string; afterFile?: string } = {}) {
  const beforePath = params.beforeFile || process.argv[3];
  const afterPath = params.afterFile || process.argv[4];

  if (!beforePath || !afterPath) throw new Error('Missing snapshot paths.');

  const beforeData = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const afterData = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const beforeMap = new Map<string, SnapshotEntry>(
    beforeData.entries.map((e: SnapshotEntry) => [e.ledgerKey, e]),
  );
  const afterMap = new Map<string, SnapshotEntry>(
    afterData.entries.map((e: SnapshotEntry) => [e.ledgerKey, e]),
  );

  let added = 0;
  let removed = 0;
  let modified = 0;
  let ttlOnly = 0;
  let unchanged = 0;

  console.log(`=== Soroban State Snapshot Diff ===`);

  afterMap.forEach((afterEntry: SnapshotEntry, key: string) => {
    const beforeEntry = beforeMap.get(key);

    if (!beforeEntry) {
      added++;
    } else if (beforeEntry.valueXdr !== afterEntry.valueXdr) {
      modified++;
    } else if (beforeEntry.liveUntilLedgerSeq !== afterEntry.liveUntilLedgerSeq) {
      ttlOnly++;
    } else {
      unchanged++;
    }
  });

  beforeMap.forEach((_, key: string) => {
    if (!afterMap.has(key)) removed++;
  });

  console.log(`Added: ${added}`);
  console.log(`Removed: ${removed}`);
  console.log(`Modified (Value): ${modified}`);
  console.log(`Modified (TTL only): ${ttlOnly}`);
  console.log(`Unchanged: ${unchanged}`);
}
