import { rpc, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';

import {
  formatContractSpecReport,
  parseContractSpec,
  selectFunction,
  specFromWasm,
} from '../utils/spec-parser';

/**
 * Example 107: Soroban Contract Specification Introspection
 *
 * Soroban contracts embed ScSpec metadata in their WASM. This example fetches
 * on-chain WASM via Soroban RPC, parses the specification, and displays
 * functions, arguments, return types, and user-defined types. It also
 * demonstrates dynamic function selection for tooling and explorers.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export interface ContractSpecIntrospectionParams {
  contractId?: string;
  functionName?: string;
  rpcUrl?: string;
}

export function normalizeContractId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Missing contract ID. Provide a contract ID starting with "C".');
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(`Invalid contract ID "${trimmed}".`);
  }
  return trimmed;
}

export async function run(params: ContractSpecIntrospectionParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractInput =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_CONTRACT_ID;
  const functionName =
    params.functionName?.trim() ||
    process.env.CONTRACT_FUNCTION?.trim() ||
    process.argv[4]?.trim();

  console.log(chalk.bold('Soroban Contract Specification Introspection'));
  console.log(chalk.blue(`Soroban RPC: ${rpcUrl}`));

  let contractId: string;
  try {
    contractId = normalizeContractId(contractInput);
  } catch (err: any) {
    console.log(chalk.red(err?.message ?? err));
    return;
  }

  const server = new rpc.Server(rpcUrl);
  console.log(`Contract ID: ${contractId}`);

  let wasm: Buffer;
  try {
    console.log(chalk.yellow('\nFetching contract WASM from the ledger...'));
    wasm = await server.getContractWasmByContractId(contractId);
    console.log(chalk.green(`WASM fetched (${wasm.length.toLocaleString()} bytes).`));
  } catch (err: any) {
    console.log(chalk.red(`Could not fetch WASM: ${err?.message ?? err}`));
    console.log(chalk.cyan(
      'Verify the contract ID is deployed on this network. Missing WASM usually means ' +
        'the contract does not exist here or the RPC node is unreachable.',
    ));
    return;
  }

  const spec = specFromWasm(wasm);
  if (!spec || spec.entries.length === 0) {
    console.log(chalk.yellow('\nNo contract specification metadata found in this WASM.'));
    console.log(chalk.gray(
      'Contracts compiled without soroban-sdk spec export, or with stripped metadata, ' +
        'cannot be introspected at runtime. Use the contract source or Stellar CLI instead.',
    ));
    return;
  }

  const parsed = parseContractSpec(spec);
  console.log('\n' + formatContractSpecReport(parsed, contractId));

  const selected = selectFunction(parsed, functionName);
  console.log(chalk.bold('\nDynamic function selection'));
  if (!selected) {
    console.log(chalk.yellow(
      functionName
        ? `Function "${functionName}" was not found in the specification.`
        : 'No exported functions are available to select.',
    ));
  } else {
    console.log(`Selected function: ${chalk.cyan(selected.name)}`);
    console.log(`Arguments:`);
    selected.inputs.forEach((input) => {
      console.log(`  - ${input.name}: ${input.type}`);
    });
    console.log(`Returns: ${selected.outputs.length ? selected.outputs.join(', ') : 'void'}`);
    if (selected.documentation) {
      console.log(`Documentation: ${selected.documentation}`);
    }

    try {
      const schema = spec.jsonSchema(selected.name);
      const preview = JSON.stringify(schema, null, 2).split('\n').slice(0, 20).join('\n');
      console.log(chalk.gray('\nJSON Schema preview (draft-07):'));
      console.log(chalk.gray(preview));
    } catch (err: any) {
      console.log(chalk.gray(`JSON schema preview skipped: ${err?.message ?? err}`));
    }
  }

  console.log(chalk.cyan(
    '\nSDK and explorer usage:\n' +
      '  - contract.Spec.fromWasm(wasm) powers runtime introspection in the JS SDK.\n' +
      '  - Stellar CLI uses the same metadata for `stellar contract invoke -- --help`.\n' +
      '  - Stellar Lab Contract Explorer renders forms from spec.jsonSchema().\n' +
      '  - contract.Client auto-generates typed methods from the parsed specification.',
  ));

  console.log(chalk.green('\nContract specification introspection example completed.'));
}
