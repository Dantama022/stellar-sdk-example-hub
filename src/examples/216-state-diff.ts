import fs from 'fs';

export async function run(params: { beforeFile?: string; afterFile?: string } = {}) {
  const beforePath = params.beforeFile || process.argv[3];
  const afterPath = params.afterFile || process.argv[4];

  if (!beforePath || !afterPath) throw new Error("Missing snapshot paths.");

  const beforeData = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const afterData = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const beforeMap = new Map(beforeData.entries.map((e: any) => [e.ledgerKey, e]));
  const afterMap = new Map(afterData.entries.map((e: any) => [e.ledgerKey, e]));

  let added = 0, removed = 0, modified = 0, ttlOnly = 0, unchanged = 0;

  console.log(`=== Soroban State Snapshot Diff ===`);
  
  afterMap.forEach((afterEntry, key) => {
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

  beforeMap.forEach((_, key) => {
    if (!afterMap.has(key)) removed++;
  });

  console.log(`Added: ${added}`);
  console.log(`Removed: ${removed}`);
  console.log(`Modified (Value): ${modified}`);
  console.log(`Modified (TTL only): ${ttlOnly}`);
  console.log(`Unchanged: ${unchanged}`);
}