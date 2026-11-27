/** Decoding of ScVal return values into JS values. No network access. */
import { scValToBigInt, xdr } from '@stellar/stellar-sdk';
import { TokenInspectionError } from './types';

/**
 * Decode an i128 token amount. The token interface returns i128 for balance and allowance.
 * Any other ScVal type is rejected rather than coerced, because a contract that merely
 * shares a method name is not necessarily a token.
 */
export function decodeI128Amount(val: xdr.ScVal, method: string): bigint {
  const type = val.switch().name;
  if (type !== 'scvI128') {
    throw new TokenInspectionError(
      'UNEXPECTED_RETURN_TYPE',
      `"${method}" returned ${type}; the token interface specifies i128.`
    );
  }
  const amount = scValToBigInt(val);
  if (amount < 0n) {
    throw new TokenInspectionError(
      'UNEXPECTED_RETURN_TYPE',
      `"${method}" returned a negative amount (${amount}), which a valid token never reports.`
    );
  }
  return amount;
}

/** Decode a u32 (the type of `decimals`). Range checking happens in validateDecimals. */
export function decodeU32(val: xdr.ScVal, method: string): number {
  const type = val.switch().name;
  if (type !== 'scvU32') {
    throw new TokenInspectionError(
      'UNEXPECTED_RETURN_TYPE',
      `"${method}" returned ${type}; the token interface specifies u32.`
    );
  }
  return val.u32();
}
