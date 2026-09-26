import fs from 'fs';

export async function run(params: { snapshotFile?: string } = {}) {
  const snapshotPath = params.snapshotFile || process.argv[3];
  if (!snapshotPath) throw new Error('Missing snapshot file path.');

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  console.log(`=== Soroban State Dependency Analysis ===`);
  const entries: any[] = snapshot.entries || [];

  const deps = new Map<string, Set<string>>();
  const reverseDeps = new Map<string, Set<string>>();

  entries.forEach((entry: any) => {
    const key = entry.ledgerKey;
    const entryStr = JSON.stringify(entry.valueDecoded || entry.valueXdr || entry);
    // Extract addresses (G...) and contract IDs (C...)
    const refs = new Set<string>(entryStr.match(/(C[A-Z2-7]{55}|G[A-Z2-7]{55})/g) || []);

    // Remove self-references
    if (refs.has(key)) refs.delete(key);
    deps.set(key, refs);

    refs.forEach((r) => {
      if (!reverseDeps.has(r)) reverseDeps.set(r, new Set());
      reverseDeps.get(r)!.add(key);
    });
  });

  console.log(`Analyzed ${entries.length} entries.`);
  let isolated = 0;

  deps.forEach((refs, key) => {
    if (refs.size > 0) {
      console.log(`\nEntry: ${key.substring(0, 20)}...`);
      console.log(`  References:`);
      refs.forEach((r) => console.log(`    -> ${r}`));
    } else {
      isolated++;
    }
  });

  console.log(`\nIsolated entries (no references): ${isolated}`);

  console.log(`\nHighly Referenced Values:`);
  reverseDeps.forEach((sources, ref) => {
    if (sources.size > 1) {
      console.log(`  ${ref} is referenced by ${sources.size} distinct entries.`);
    }
  });
}
