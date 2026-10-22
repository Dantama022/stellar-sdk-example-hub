import fs from 'node:fs/promises';

import {
  prepareSep12CustomerFields,
  validateCustomerJson,
} from './customer-information-validator/validator';

const SAMPLE_JSON = JSON.stringify({
  fields: {
    first_name: 'Jordan',
    email_address: 'jordan@example.test',
    birth_date: '1990-04-12',
  },
});

interface CliOptions {
  filePath?: string;
  json: boolean;
  requiredFields: string[];
}

export async function run(
  options: CliOptions = { json: false, requiredFields: ['first_name', 'email_address'] },
): Promise<void> {
  const input = options.filePath ? await fs.readFile(options.filePath, 'utf8') : SAMPLE_JSON;
  const report = validateCustomerJson(input, { requiredFields: options.requiredFields });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.valid && !options.json) {
    const payload = JSON.parse(input) as { fields: Record<string, unknown> };
    const prepared = prepareSep12CustomerFields(payload.fields);
    console.log(
      `SEP-12 preparation is ready locally: ${Object.keys(prepared.values).length} text/number field(s), ${Object.keys(prepared.binaryFields).length} binary field(s). No request was sent.`,
    );
  }

  process.exitCode = report.valid ? 0 : 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, requiredFields: ['first_name', 'email_address'] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--file') {
      const filePath = args[index + 1];
      if (!filePath) throw new Error('--file requires a JSON file path');
      options.filePath = filePath;
      index += 1;
    } else if (arg === '--required') {
      const value = args[index + 1];
      if (typeof value === 'undefined') throw new Error('--required requires a comma-separated field list');
      options.requiredFields = value.split(',').map((field) => field.trim()).filter(Boolean);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printReport(report: ReturnType<typeof validateCustomerJson>): void {
  console.log(`Validation: ${report.valid ? 'VALID' : 'INVALID'}`);
  console.log(`Recognized fields: ${report.recognizedFields.join(', ') || 'none'}`);
  console.log(`Missing required fields: ${report.missingRequiredFields.join(', ') || 'none'}`);
  console.log(
    `Invalid values: ${report.invalidValues.map(({ field, rule }) => `${field} (${rule})`).join('; ') || 'none'}`,
  );
  console.log(`Unknown fields: ${report.unknownFields.join(', ') || 'none'}`);
  console.log(`Structure errors: ${report.structureErrors.join('; ') || 'none'}`);
  console.log('Next steps:');
  for (const step of report.nextSteps) console.log(`- ${step}`);
  console.log('Local checks do not verify identity, establish compliance, or replace anchor-specific rules.');
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch(() => {
    console.error('Unable to read or process input. Check the JSON file path and syntax; customer values are not logged.');
    process.exitCode = 1;
  });
}