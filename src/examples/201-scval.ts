import { xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

export async function run(params: { action?: string; value?: string; type?: string } = {}) {
  const action = params.action || process.argv[3]; // 'encode' | 'decode'

  console.log(`=== ScVal Encoding & Decoding Playground ===`);
  if (action === 'encode') {
    const inputStr = params.value || process.argv[4];
    const typeHint = params.type || process.argv[5];
    if (!inputStr) throw new Error('Missing input value to encode.');

    const input = JSON.parse(inputStr);
    let scVal: xdr.ScVal;

    if (typeHint === 'address') {
      scVal = nativeToScVal(input, { type: 'address' });
    } else if (typeHint === 'symbol') {
      scVal = nativeToScVal(input, { type: 'symbol' });
    } else {
      scVal = nativeToScVal(input);
    }

    console.log(`Input:`, input);
    console.log(`Detected/Selected Type: ${typeHint || 'auto'}`);
    console.log(`Encoded XDR (base64):\n${scVal.toXDR('base64')}`);
  } else if (action === 'decode') {
    const xdrStr = params.value || process.argv[4];
    if (!xdrStr) throw new Error('Missing XDR string to decode.');

    const scVal = xdr.ScVal.fromXDR(xdrStr, 'base64');
    let decoded;
    try {
      decoded = scValToNative(scVal);
    } catch (e: any) {
      decoded = `[Undecodable] ${e.message}`;
    }

    console.log(`Base64 XDR: ${xdrStr}`);
    console.log(`ScVal Structure:`, JSON.stringify(scVal, null, 2).substring(0, 100) + '...');
    console.log(`Decoded Value:`, decoded);
  } else {
    throw new Error("Invalid action. Use 'encode' or 'decode'.");
  }
}
