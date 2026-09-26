import fs from 'fs';
import { parseEventRecord } from './67-soroban-contract-events';

export async function run(params: { eventFile?: string; schemaFile?: string } = {}) {
  const eventPath = params.eventFile || process.argv[3];
  const schemaPath = params.schemaFile || process.argv[4];

  if (!eventPath || !schemaPath) throw new Error('Missing file paths.');

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const events = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

  const eventArray = Array.isArray(events) ? events : [events];

  let valid = 0,
    invalid = 0;
  console.log(`=== Schema and Payload Validator ===`);

  eventArray.forEach((rawEvent: any, index: number) => {
    const parsed = parseEventRecord(rawEvent);
    const schemaDef = schema.events.find((e: any) => e.id === parsed.eventName);

    if (!schemaDef) {
      console.log(`[Event ${index}] INVALID: Event '${parsed.eventName}' missing in schema.`);
      invalid++;
      return;
    }

    if (parsed.topics.length !== schemaDef.topics.length) {
      console.log(
        `[Event ${index}] INVALID: Topic count mismatch (Expected ${schemaDef.topics.length}, got ${parsed.topics.length}).`,
      );
      invalid++;
      return;
    }

    // Example payload validation hook
    const payloadType = parsed.value?.xdrType;
    if (schemaDef.payload && schemaDef.payload.type !== payloadType) {
      console.log(
        `[Event ${index}] INVALID: Payload type mismatch. Expected ${schemaDef.payload.type}, got ${payloadType}.`,
      );
      invalid++;
      return;
    }

    valid++;
  });

  console.log(`\nValidation Statistics:`);
  console.log(`  Total Evaluated : ${eventArray.length}`);
  console.log(`  Valid Structure : ${valid}`);
  console.log(`  Invalid/Mismatch: ${invalid}`);
}
