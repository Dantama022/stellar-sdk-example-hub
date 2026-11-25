/**
 * Soroban argument encoder and validator.
 *
 * Read-only: this prepares and inspects contract arguments. It never builds a
 * transaction, signs, or submits anything, and it needs no network or keys.
 *
 *   npx ts-node index.ts
 */

import type { xdr } from '@stellar/stellar-sdk';
import { EncodingError, encodeArguments, type EncodedArgument } from './encoder';
import { buildReport, formatReport, type EncodingReport } from './report';
import { validateFunctionDefinition, type FunctionDefinition } from './schema';
import { SpecificationError, getFunctionDefinition, parseSpecification } from './specification';
import { validateArguments } from './validator';

export * from './schema';
export * from './validator';
export * from './encoder';
export * from './specification';
export * from './report';

export interface PrepareOptions {
  functionName: string;
  args: Record<string, unknown>;
  contractAddress?: string;
  /** Explicit argument schema. Takes precedence over the specification. */
  definition?: FunctionDefinition;
  /** Contract specification entries (base64 XDR or decoded). */
  specEntries?: Array<string | xdr.ScSpecEntry>;
}

export interface PreparedInvocation {
  report: EncodingReport;
  /** ScVal arguments in call order; empty when validation failed. */
  encoded: EncodedArgument[];
}

/** Validate, then (only if valid) encode, and describe the outcome in a report. */
export function prepareArguments(options: PrepareOptions): PreparedInvocation {
  const { functionName, args, contractAddress } = options;
  let definition = options.definition;
  let schemaSource: EncodingReport['schemaSource'] = definition ? 'explicit' : 'none';

  if (!definition && options.specEntries) {
    try {
      definition = getFunctionDefinition(parseSpecification(options.specEntries), functionName);
      schemaSource = 'specification';
    } catch (err) {
      const message = err instanceof SpecificationError ? `specification: ${err.message}` : (err as Error).message;
      return { report: buildReport({ contractAddress, functionName, schemaSource, errors: [message] }), encoded: [] };
    }
  }

  if (!definition) {
    return {
      report: buildReport({
        contractAddress,
        functionName,
        schemaSource,
        errors: ['no argument schema available: provide `definition` or `specEntries`'],
      }),
      encoded: [],
    };
  }

  const definitionProblems = validateFunctionDefinition(definition);
  if (definitionProblems.length > 0) {
    return {
      report: buildReport({ contractAddress, functionName, schemaSource, errors: definitionProblems.map((p) => `invalid function definition: ${p}`) }),
      encoded: [],
    };
  }

  const issues = validateArguments(definition, args);
  if (issues.some((i) => i.severity === 'error')) {
    return { report: buildReport({ contractAddress, functionName, schemaSource, definition, issues }), encoded: [] };
  }

  try {
    const encoded = encodeArguments(definition, args);
    return { report: buildReport({ contractAddress, functionName, schemaSource, definition, issues, encoded }), encoded };
  } catch (err) {
    const message = err instanceof EncodingError ? `encoding failed: ${err.message}` : `encoding failed: ${(err as Error).message}`;
    return { report: buildReport({ contractAddress, functionName, schemaSource, definition, issues, errors: [message] }), encoded: [] };
  }
}

function demo(): void {
  const definition: FunctionDefinition = {
    name: 'transfer',
    args: [
      { name: 'from', type: { kind: 'address' } },
      { name: 'to', type: { kind: 'address' } },
      { name: 'amount', type: { kind: 'i128' } },
    ],
  };
  const { report } = prepareArguments({
    functionName: 'transfer',
    definition,
    args: {
      from: 'GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX',
      to: 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA',
      amount: '170141183460469231731687303715884105727', // i128 max, passed as a string to keep precision
    },
  });
  console.log(formatReport(report));
  process.exitCode = report.valid ? 0 : 1;
}

if (require.main === module) demo();
