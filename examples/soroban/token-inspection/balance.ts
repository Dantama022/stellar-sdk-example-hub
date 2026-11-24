/** Token balance and decimals retrieval. */
import { Address } from '@stellar/stellar-sdk';
import { decodeI128Amount, decodeU32 } from './decode';
import { validateDecimals } from './format';
import { InvokeContext, invokeReadOnly } from './invoke';

/** `balance(id: Address) -> i128` */
export async function readBalance(ctx: InvokeContext, account: string): Promise<bigint> {
  const val = await invokeReadOnly(ctx, 'balance', [new Address(account).toScVal()]);
  return decodeI128Amount(val, 'balance');
}

/** `decimals() -> u32`, range-checked. */
export async function readDecimals(ctx: InvokeContext): Promise<number> {
  const val = await invokeReadOnly(ctx, 'decimals', []);
  return validateDecimals(decodeU32(val, 'decimals'));
}
