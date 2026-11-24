/**
 * Amount formatting. Pure functions, no network access.
 *
 * Token amounts are integers in the token's smallest unit. A token with 7 decimals
 * stores 1.5 tokens as 15_000_000. Everything here works on bigint so values beyond
 * Number.MAX_SAFE_INTEGER (2^53 - 1) keep every digit.
 */
import { TokenInspectionError } from './types';

/** i128 has at most 39 digits, so more than 38 decimals is never meaningful. */
export const MAX_DECIMALS = 38;

/** Validate a decimals value (from the contract or supplied by the user). */
export function validateDecimals(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    throw new TokenInspectionError(
      'INVALID_DECIMALS',
      `Token decimals must be an integer between 0 and ${MAX_DECIMALS}; got ${String(value)}.`
    );
  }
  return value;
}

/**
 * Render `raw / 10^decimals` as an exact decimal string.
 * Trailing fractional zeros are trimmed unless `keepTrailingZeros` is set.
 */
export function formatTokenAmount(
  raw: bigint,
  decimals: number,
  keepTrailingZeros = false
): string {
  if (typeof raw !== 'bigint') {
    throw new TokenInspectionError(
      'FORMAT_ERROR',
      `Cannot format a ${typeof raw}; raw token amounts must be bigint.`
    );
  }
  validateDecimals(decimals);

  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals);
  if (!keepTrailingZeros) fraction = fraction.replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
