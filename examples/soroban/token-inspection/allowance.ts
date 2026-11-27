/** Allowance retrieval: `allowance(from: Address, spender: Address) -> i128`. */
import { Address } from '@stellar/stellar-sdk';
import { decodeI128Amount } from './decode';
import { InvokeContext, invokeReadOnly } from './invoke';
import { AllowanceResult, TokenInspectionError } from './types';

export async function readAllowance(
  ctx: InvokeContext,
  owner: string,
  spender: string
): Promise<bigint> {
  const val = await invokeReadOnly(ctx, 'allowance', [
    new Address(owner).toScVal(),
    new Address(spender).toScVal(),
  ]);
  return decodeI128Amount(val, 'allowance');
}

/**
 * Classify a failed allowance lookup. A missing method is "unsupported"; everything else
 * (RPC trouble, contract trap, wrong return type) is "failed". Neither is the same as an
 * allowance of zero.
 */
export function classifyAllowanceFailure(e: unknown): Pick<AllowanceResult, 'status' | 'error'> {
  const err =
    e instanceof TokenInspectionError
      ? e
      : new TokenInspectionError('INVOCATION_FAILED', (e as Error).message);
  const unsupported = err.code === 'METHOD_NOT_FOUND' || err.code === 'UNSUPPORTED_INTERFACE';
  return {
    status: unsupported ? 'unsupported' : 'failed',
    error: { code: err.code, message: err.message },
  };
}
