import fs from 'fs';

export async function run(params: { schemaFile?: string } = {}) {
  const path = params.schemaFile || process.argv[3];
  if (!path) throw new Error('Missing schema path.');

  const schema = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log(`// Generated TypeScript types for Soroban Events\n// Source: ${path}\n`);

  schema.events.forEach((event: any) => {
    console.log(`export interface ${event.id}Event {`);
    console.log(`  topics: [`);
    event.topics.forEach((t: any) => console.log(`    ${mapType(t.type)},`));
    console.log(`  ];`);
    console.log(`  payload: ${mapType(event.payload.type)};`);
    console.log(`}\n`);
  });
}

function mapType(sorobanType: string): string {
  const map: Record<string, string> = {
    scvI128: 'bigint',
    scvU32: 'number',
    scvSymbol: 'string',
    scvAddress: 'string',
  };
  return map[sorobanType] || 'unknown';
}