import { nativeToScVal } from '@stellar/stellar-sdk';

export async function run(
  params: { contractId?: string; functionName?: string; args?: string } = {},
) {
  const contractId = params.contractId || process.argv[3];
  const funcName = params.functionName || process.argv[4];
  const argsJson = params.args || process.argv[5];

  if (!contractId || !funcName || !argsJson) {
    throw new Error('Missing parameters. Usage: build-args <contractId> <function> <argsJson>');
  }

  let parsedArgs: any;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch (e: any) {
    throw new Error(`Invalid JSON input: ${e.message}`);
  }

  console.log(`=== Contract Argument Builder ===`);
  console.log(`Contract: ${contractId}`);
  console.log(`Function: ${funcName}`);
  console.log(`Input JSON:`, parsedArgs);

  const scVals = Object.values(parsedArgs).map((val) => nativeToScVal(val));

  console.log(`\nGenerated ScVal Array (${scVals.length} arguments):`);
  scVals.forEach((scVal, idx) => {
    console.log(`Arg [${idx}]:`);
    console.log(`  Base64: ${scVal.toXDR('base64')}`);
  });
}
