import { xdr, scValToNative } from '@stellar/stellar-sdk';

function jsonReplacer(_key: string, value: any) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value;
}

export async function run(params: { input?: string } = {}) {
  const inputStr = params.input || process.argv[3];
  if (!inputStr) throw new Error('Missing ScVal base64 input.');

  console.log(`=== Return Value Decoder ===`);
  console.log(`Input Base64: ${inputStr}`);

  try {
    const scVal = xdr.ScVal.fromXDR(inputStr, 'base64');
    let xdrType = 'unknown';
    try {
      const discriminant = (scVal as any).switch?.();
      xdrType = discriminant?.name ?? 'unknown';
    } catch {
      // Fallback to 'unknown' if switch discriminant cannot be resolved
    }

    const decoded = scValToNative(scVal);

    console.log(`ScVal Type: ${xdrType}`);
    console.log(`Decoded Output:\n${JSON.stringify(decoded, jsonReplacer, 2)}`);
  } catch (e: any) {
    console.error(`Decoding failed: ${e.message}`);
  }
}
