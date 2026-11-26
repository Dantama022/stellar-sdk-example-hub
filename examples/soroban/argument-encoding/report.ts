/**
 * Structured encoding report. Pure formatting of results produced elsewhere.
 */

import type { EncodedArgument } from './encoder';
import type { FunctionDefinition } from './schema';
import { formatType } from './schema';
import type { ValidationIssue } from './validator';

export interface ArgumentReport {
  name: string;
  expectedType: string;
  status: 'valid' | 'invalid' | 'not-encoded';
  encoded?: { scValType: string; xdrBase64: string };
  issues: ValidationIssue[];
}

export interface EncodingReport {
  contractAddress?: string;
  functionName: string;
  /** `specification` when derived from a contract spec, `explicit` when supplied by hand. */
  schemaSource: 'specification' | 'explicit' | 'none';
  valid: boolean;
  arguments: ArgumentReport[];
  /** Problems not tied to one declared argument (unexpected arguments, bad spec, ...). */
  errors: string[];
  warnings: string[];
  /** Always true here: this example prepares arguments and never submits anything. */
  readOnly: true;
  note: string;
}

const NOTE =
  'Valid encoding means the arguments have the right ScVal types. It does not prove the contract call will succeed: authorization, contract state and business rules are only checked on-chain.';

export function buildReport(input: {
  contractAddress?: string;
  functionName: string;
  schemaSource: EncodingReport['schemaSource'];
  definition?: FunctionDefinition;
  issues?: ValidationIssue[];
  encoded?: EncodedArgument[];
  errors?: string[];
}): EncodingReport {
  const issues = input.issues ?? [];
  const errors = [...(input.errors ?? [])];
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  const hardIssues = issues.filter((i) => i.severity === 'error');
  const declared = new Set((input.definition?.args ?? []).map((a) => a.name));

  const args: ArgumentReport[] = (input.definition?.args ?? []).map((arg) => {
    const own = issues.filter((i) => i.path === arg.name || i.path.startsWith(`${arg.name}.`) || i.path.startsWith(`${arg.name}[`));
    const enc = input.encoded?.find((e) => e.name === arg.name);
    const failed = own.some((i) => i.severity === 'error');
    return {
      name: arg.name,
      expectedType: formatType(arg.type),
      status: failed ? 'invalid' : enc ? 'valid' : 'not-encoded',
      encoded: enc && !failed ? { scValType: enc.scValType, xdrBase64: enc.xdrBase64 } : undefined,
      issues: own,
    };
  });

  for (const i of hardIssues) {
    const root = i.path.split(/[.[]/)[0];
    if (!declared.has(root)) errors.push(i.message);
  }

  return {
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    schemaSource: input.schemaSource,
    valid: errors.length === 0 && hardIssues.length === 0 && args.every((a) => a.status === 'valid'),
    arguments: args,
    errors,
    warnings,
    readOnly: true,
    note: NOTE,
  };
}

export function formatReport(report: EncodingReport): string {
  const lines = [
    `Function: ${report.functionName}${report.contractAddress ? ` @ ${report.contractAddress}` : ''}`,
    `Schema:   ${report.schemaSource}`,
    `Result:   ${report.valid ? 'VALID' : 'INVALID'}`,
    '',
  ];
  for (const a of report.arguments) {
    lines.push(`- ${a.name}: ${a.expectedType} [${a.status}]`);
    if (a.encoded) lines.push(`    ${a.encoded.scValType}  ${a.encoded.xdrBase64}`);
    for (const i of a.issues) lines.push(`    ! ${i.code}: ${i.message}`);
  }
  for (const e of report.errors) lines.push(`error: ${e}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push('', report.note);
  return lines.join('\n');
}
