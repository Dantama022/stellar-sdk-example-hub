import fs from 'fs';
import { parseEventRecord } from './67-soroban-contract-events'; 

export async function run(params: { schemaFile?: string; eventsFile?: string } = {}) {
  const schemaPath = params.schemaFile || process.argv[3];
  const eventsPath = params.eventsFile || process.argv[4];

  if (!schemaPath || !eventsPath) throw new Error("Missing file paths.");

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

  let incompatibilities = 0;
  console.log(`=== Event Compatibility Report ===`);
  
  events.forEach((rawEvent: any) => {
    const parsed = parseEventRecord(rawEvent);
    const schemaDef = schema.events.find((e: any) => e.id === parsed.eventName);
    
    if (!schemaDef) {
      console.log(`[Mismatch] Event ${parsed.eventName || 'unknown'} not found in schema.`);
      incompatibilities++;
    } else if (parsed.topics.length !== schemaDef.topics.length) {
      console.log(`[Mismatch] Event ${parsed.eventName}: Expected ${schemaDef.topics.length} topics, got ${parsed.topics.length}.`);
      incompatibilities++;
    }
  });

  console.log(`\nChecked ${events.length} events. Found ${incompatibilities} incompatibilities.`);
}