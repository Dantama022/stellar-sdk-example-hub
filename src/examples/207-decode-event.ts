import { xdr, scValToNative } from '@stellar/stellar-sdk';

function jsonReplacer(_key: string, value: any) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value;
}

function safeDecode(base64: string) {
  try {
    const sc = xdr.ScVal.fromXDR(base64, 'base64');
    return scValToNative(sc);
  } catch {
    return `[Undecodable Base64: ${base64}]`;
  }
}

export async function run(params: { eventInput?: string } = {}) {
  const inputStr = params.eventInput || process.argv[3];
  if (!inputStr) throw new Error('Missing event JSON input.');

  console.log(`=== Soroban Event Decoder ===`);
  let eventRecord;
  try {
    eventRecord = JSON.parse(inputStr);
  } catch {
    throw new Error('Input must be a valid JSON string representing an event.');
  }

  console.log(`Contract ID: ${eventRecord.contractId || 'unknown'}`);
  console.log(`Ledger: ${eventRecord.ledger || 'unknown'}`);

  const topics = eventRecord.topic || [];
  console.log(`\nTopics (${topics.length}):`);
  topics.forEach((t: string, i: number) => {
    console.log(`  [${i}]: ${JSON.stringify(safeDecode(t), jsonReplacer)}`);
  });

  console.log(`\nEvent Data Payload:`);
  if (eventRecord.value) {
    const dataBase64 =
      typeof eventRecord.value === 'string' ? eventRecord.value : eventRecord.value.xdr;
    console.log(`  Decoded:`, JSON.stringify(safeDecode(dataBase64), jsonReplacer, 2));
  } else {
    console.log(`  No data payload.`);
  }
}
