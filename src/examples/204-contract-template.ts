export async function run(params: { contractId?: string; functionName?: string } = {}) {
  const contractId = params.contractId || process.argv[3];
  const funcName = params.functionName || process.argv[4];

  if (!contractId || !funcName) throw new Error('Missing contract ID or function name.');

  console.log(`=== Contract Invocation Template ===`);
  console.log(`Contract: ${contractId}`);
  console.log(`Function: ${funcName}\n`);

  console.log(`// TypeScript Invocation Template`);
  console.log(`import { Contract, nativeToScVal } from '@stellar/stellar-sdk';\n`);
  console.log(`const contract = new Contract('${contractId}');`);
  console.log(`const args = [`);
  console.log(`  // TODO: Replace placeholders with valid argument representations`);
  console.log(`  nativeToScVal('example_value'),`);
  console.log(`];\n`);
  console.log(`const tx = contract.call('${funcName}', ...args);`);

  console.log(`\n// JSON Argument Template (CLI input format)`);
  console.log(JSON.stringify({ arg1: 'example_value' }, null, 2));
}
