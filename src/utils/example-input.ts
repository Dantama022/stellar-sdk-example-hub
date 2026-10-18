import { Asset, StrKey } from '@stellar/stellar-sdk';

export class WorkflowError extends Error {}

export function accountId(input = ''): string {
  if (!StrKey.isValidEd25519PublicKey(input))
    throw new WorkflowError('Expected a valid G... account public key');
  return input;
}

export function asset(input = ''): Asset {
  if (/^(native|XLM)$/i.test(input)) return Asset.native();
  const parts = input.split(':');
  if (parts.length !== 2 || !/^[a-zA-Z0-9]{1,12}$/.test(parts[0])) {
    throw new WorkflowError(
      'Asset must be native or CODE:G...ISSUER (1–12 alphanumeric characters)',
    );
  }
  return new Asset(parts[0], accountId(parts[1]));
}

export function amount(input = '', allowZero = false): string {
  if (!/^\d+(\.\d{1,7})?$/.test(input))
    throw new WorkflowError('Amount needs at most seven decimal places');
  const units = amountUnits(input);
  if (units > 9223372036854775807n || (allowZero ? units < 0n : units <= 0n)) {
    throw new WorkflowError('Amount is outside the positive Stellar int64 range');
  }
  return input;
}

export function amountUnits(input: string): bigint {
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
}
