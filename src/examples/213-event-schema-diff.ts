import fs from 'fs';

export async function run(params: { oldSchema?: string; newSchema?: string } = {}) {
  const oldPath = params.oldSchema || process.argv[3];
  const newPath = params.newSchema || process.argv[4];

  if (!oldPath || !newPath) throw new Error('Missing schema paths.');

  const oldSchema = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const newSchema = JSON.parse(fs.readFileSync(newPath, 'utf8'));

  console.log(`=== Soroban Schema Diff ===`);
  const added = newSchema.events.filter(
    (n: any) => !oldSchema.events.find((o: any) => o.id === n.id),
  );
  const removed = oldSchema.events.filter(
    (o: any) => !newSchema.events.find((n: any) => n.id === o.id),
  );

  console.log(`Added Events: ${added.length}`);
  added.forEach((e: any) => console.log(`  + ${e.id}`));

  console.log(`Removed Events: ${removed.length}`);
  removed.forEach((e: any) => console.log(`  - ${e.id}`));

  // In a full implementation, recursively check topic ordering and payload types here.
  console.log(`\nDiff complete. Identical schemas produce zero changes.`);
}