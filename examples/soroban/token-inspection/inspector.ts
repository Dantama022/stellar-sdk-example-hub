/**
 * Orchestrates a read-only token inspection. Expected failures are reported in the
 * result (`status` + `error`) instead of being thrown.
 */
import { classifyAllowanceFailure, readAllowance } from './allowance';
import { readBalance, readDecimals } from './balance';
import {
  NETWORKS,
  NetworkName,
  validateAccountAddress,
  validateContractAddress,
  validateSpenderAddress,
} from './config';
import { formatTokenAmount, validateDecimals } from './format';
import { InvokeContext, TokenRpcClient, createRpcClient, rpcCall } from './invoke';
import {
  STELLAR_ASSET_REPORT,
  UNAVAILABLE_REPORT,
  reportFromFunctions,
  specFunctions,
} from './spec';
import {
  AllowanceResult,
  InterfaceReport,
  TokenInspectionError,
  TokenInspectionResult,
} from './types';

export interface InspectOptions {
  network?: NetworkName;
  rpcUrl?: string;
  /** Optional spender; when set, the allowance the account (owner) granted it is inspected. */
  spender?: string;
  /** Explicit decimals. Skips the contract's `decimals()` call. */
  decimals?: number;
  /** Inject a client (used by tests). */
  client?: TokenRpcClient;
}

export async function inspectToken(
  tokenContract: string,
  account: string,
  options: InspectOptions = {}
): Promise<TokenInspectionResult> {
  const network = NETWORKS[options.network ?? 'testnet'];
  const result: TokenInspectionResult = {
    status: 'error',
    network: network.name,
    networkPassphrase: network.passphrase,
    tokenContract,
    account,
    warnings: [],
  };

  try {
    validateContractAddress(tokenContract);
    validateAccountAddress(account);
    if (options.spender !== undefined) validateSpenderAddress(options.spender);
    const explicitDecimals =
      options.decimals !== undefined ? validateDecimals(options.decimals) : undefined;

    const client = options.client ?? createRpcClient(options.rpcUrl ?? network.defaultRpcUrl);
    const actual = await rpcCall(() => client.getNetwork());
    if (actual.passphrase !== network.passphrase) {
      throw new TokenInspectionError(
        'NETWORK_MISMATCH',
        `Requested ${network.name} but the RPC endpoint reports a different network ("${actual.passphrase}").`
      );
    }
    const ctx: InvokeContext = {
      client,
      networkPassphrase: network.passphrase,
      contractId: tokenContract,
    };

    const report = await inspectInterface(ctx, result.warnings);
    result.interface = report;
    if (report.methods.balance === false) {
      throw new TokenInspectionError(
        'UNSUPPORTED_INTERFACE',
        'The contract spec has no balance(Address) function, so it does not implement the token interface.'
      );
    }

    let raw: bigint;
    try {
      raw = await readBalance(ctx, account);
    } catch (e) {
      if (e instanceof TokenInspectionError && e.code === 'METHOD_NOT_FOUND') {
        throw new TokenInspectionError('UNSUPPORTED_INTERFACE', `Not a token contract: ${e.message}`);
      }
      throw e;
    }
    result.balance = { raw };

    // Decimals: an explicit value wins; otherwise ask the contract. Failure only blocks formatting.
    if (explicitDecimals !== undefined) {
      result.decimals = explicitDecimals;
      result.decimalsSource = 'explicit';
    } else {
      try {
        if (report.methods.decimals === false) {
          throw new TokenInspectionError(
            'METHOD_NOT_FOUND',
            'The contract spec has no decimals() function.'
          );
        }
        result.decimals = await readDecimals(ctx);
        result.decimalsSource = 'contract';
      } catch (e) {
        result.warnings.push(
          `Token decimals unavailable (${(e as Error).message}). Raw amounts are exact but cannot be formatted; pass explicit decimals.`
        );
      }
    }
    if (result.decimals !== undefined) {
      result.balance.formatted = formatTokenAmount(raw, result.decimals);
    }

    if (options.spender !== undefined) {
      result.allowance = await inspectAllowance(ctx, report, account, options.spender, result.decimals);
    }

    const incomplete =
      result.decimals === undefined || (result.allowance && result.allowance.status !== 'ok');
    result.status = incomplete ? 'partial' : 'ok';
  } catch (e) {
    result.status = 'error';
    result.error =
      e instanceof TokenInspectionError
        ? { code: e.code, message: e.message }
        : { code: 'INVOCATION_FAILED', message: (e as Error).message };
  }
  return result;
}

async function inspectAllowance(
  ctx: InvokeContext,
  report: InterfaceReport,
  owner: string,
  spender: string,
  decimals: number | undefined
): Promise<AllowanceResult> {
  const base = { owner, spender };
  if (report.methods.allowance === false) {
    return {
      ...base,
      status: 'unsupported',
      error: {
        code: 'UNSUPPORTED_INTERFACE',
        message: 'The contract spec has no allowance(Address, Address) function.',
      },
    };
  }
  try {
    const raw = await readAllowance(ctx, owner, spender);
    return {
      ...base,
      status: 'ok',
      amount: {
        raw,
        formatted: decimals === undefined ? undefined : formatTokenAmount(raw, decimals),
      },
    };
  } catch (e) {
    return { ...base, ...classifyAllowanceFailure(e) };
  }
}

/** Find out which token methods exist. Spec failures are non-fatal: they downgrade to "unavailable". */
async function inspectInterface(ctx: InvokeContext, warnings: string[]): Promise<InterfaceReport> {
  const executable = await rpcCall(() => ctx.client.getContractExecutable(ctx.contractId));
  if (!executable) {
    throw new TokenInspectionError(
      'CONTRACT_NOT_FOUND',
      'No contract instance found. The contract may not exist on this network, or its instance entry may have expired and need restoring.'
    );
  }
  if (executable.type === 'stellar_asset') return STELLAR_ASSET_REPORT;

  try {
    const wasm = await ctx.client.getWasm(executable.wasmHash);
    return reportFromFunctions(specFunctions(wasm));
  } catch (e) {
    warnings.push(
      `Could not read the contract spec (${(e as Error).message}); method support will be learned by invoking.`
    );
    return UNAVAILABLE_REPORT;
  }
}
