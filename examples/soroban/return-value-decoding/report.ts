/**
 * Structured decoding report. Decoding errors, specification problems and type
 * mismatches are reported in separate fields so they are never confused.
 */

import type { DecodeIssue, DecodeResult, DecodeStatus } from './decoder';
import { toReadable } from './decoder';
import { formatType, type ExpectedType } from './types';
import type { ValidationResult } from './type-validator';

export interface DecodingReport {
  contractAddress?: string;
  functionName: string;
  expectedType: string | null;
  expectedTypeSource: 'explicit' | 'specification' | 'none';
  decoding: { status: DecodeStatus; errors: DecodeIssue[] };
  /** JSON-safe decoded value (bigint as string, bytes as hex); null when nothing was decoded. */
  decoded: unknown;
  raw: { scValType?: string; xdrBase64?: string };
  validation: ValidationResult;
  /** Problems with the expected type or the contract specification. */
  specificationErrors: string[];
  warnings: string[];
  readOnly: true;
  note: string;
}

const NOTE =
  'Decoding shows what the value is; validation checks its shape against the expected type. A value can decode and validate and still be wrong for your application (wrong amount, wrong account, stale data). Check meaning in application code.';

export function buildReport(input: {
  contractAddress?: string;
  functionName: string;
  expected?: ExpectedType;
  expectedTypeSource: DecodingReport['expectedTypeSource'];
  decode: DecodeResult;
  validation: ValidationResult;
  specificationErrors?: string[];
}): DecodingReport {
  const { decode } = input;
  return {
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    expectedType: input.expected ? formatType(input.expected) : null,
    expectedTypeSource: input.expectedTypeSource,
    decoding: { status: decode.status, errors: decode.errors },
    decoded: decode.node ? toReadable(decode.node) : null,
    raw: { scValType: decode.node?.scType, xdrBase64: decode.rawXdr },
    validation: input.validation,
    specificationErrors: input.specificationErrors ?? [],
    warnings: decode.warnings,
    readOnly: true,
    note: NOTE,
  };
}

export function formatReport(report: DecodingReport): string {
  const lines = [
    `Function:   ${report.functionName}${report.contractAddress ? ` @ ${report.contractAddress}` : ''}`,
    `Expected:   ${report.expectedType ?? '(unknown)'} [${report.expectedTypeSource}]`,
    `Decoding:   ${report.decoding.status}`,
    `Validation: ${report.validation.status}`,
    `Raw:        ${report.raw.scValType ?? '-'} ${report.raw.xdrBase64 ?? ''}`.trimEnd(),
    `Decoded:    ${JSON.stringify(report.decoded)}`,
  ];
  for (const e of report.decoding.errors) lines.push(`decoding error [${e.code}] ${e.path}: ${e.message}`);
  for (const e of report.specificationErrors) lines.push(`specification: ${e}`);
  for (const m of report.validation.mismatches) lines.push(`type mismatch: ${m.message}`);
  if (report.validation.reason) lines.push(`note: ${report.validation.reason}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push('', report.note);
  return lines.join('\n');
}
