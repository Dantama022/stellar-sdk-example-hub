/**
 * Soroban return value decoder and type validator.
 *
 * Read-only: decodes and checks a value you already have (for example the
 * `retval` of a simulation). It never builds, signs or submits a transaction.
 *
 *   npx ts-node index.ts
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { decodeReturnValue, type ReturnValueInput } from './decoder';
import { buildReport, formatReport, type DecodingReport } from './report';
import { SpecificationError, getReturnType, parseSpecification } from './specification';
import { validateReturnType } from './type-validator';
import { validateExpectedType, type ExpectedType } from './types';

export * from './types';
export * from './decoder';
export * from './type-validator';
export * from './specification';
export * from './report';

export interface InspectOptions {
  functionName: string;
  returnValue: ReturnValueInput;
  contractAddress?: string;
  /** Explicit expected type. Takes precedence over the specification. */
  expectedType?: ExpectedType;
  /** Contract specification entries (base64 XDR or decoded). */
  specEntries?: Array<string | xdr.ScSpecEntry>;
}

/** Decode, then validate, then describe the result. Never throws for bad input. */
export function inspectReturnValue(options: InspectOptions): DecodingReport {
  const { functionName, contractAddress } = options;
  const specificationErrors: string[] = [];
  let expected: ExpectedType | undefined;
  let source: DecodingReport['expectedTypeSource'] = 'none';

  if (options.expectedType) {
    const problems = validateExpectedType(options.expectedType);
    if (problems.length > 0) {
      specificationErrors.push(...problems.map((p) => `invalid expected type: ${p}`));
    } else {
      expected = options.expectedType;
      source = 'explicit';
    }
  } else if (options.specEntries) {
    try {
      expected = getReturnType(parseSpecification(options.specEntries), functionName);
      source = 'specification';
    } catch (err) {
      specificationErrors.push(err instanceof SpecificationError ? err.message : (err as Error).message);
    }
  }

  const decode = decodeReturnValue(options.returnValue);
  const validation = validateReturnType(decode.node, expected);
  if (specificationErrors.length > 0 && validation.status === 'inconclusive' && !validation.reason?.includes('expected')) {
    validation.reason = 'the expected type is unusable, so the value was decoded but not validated';
  }
  return buildReport({ contractAddress, functionName, expected, expectedTypeSource: source, decode, validation, specificationErrors });
}

function demo(): void {
  const value = nativeToScVal({ owner: 'owner-1', balance: 123456789012345678901234567890n }, {
    type: { owner: ['symbol', 'symbol'], balance: ['symbol', 'i128'] },
  });
  const report = inspectReturnValue({
    functionName: 'get_account',
    returnValue: value,
    expectedType: {
      kind: 'struct',
      name: 'Account',
      fields: [
        { name: 'balance', type: { kind: 'i128' } },
        { name: 'owner', type: { kind: 'symbol' } },
      ],
    },
  });
  console.log(formatReport(report));
  process.exitCode = report.validation.status === 'valid' ? 0 : 1;
}

if (require.main === module) demo();
