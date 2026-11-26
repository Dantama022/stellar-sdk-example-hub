/** #576: local ManageData validation (no transaction construction). */
import { Account, nativeBalance, stroops, unitsToAmount } from '../_shared/horizon-readonly';

export const MAX_DATA_BYTES = 64; // Stellar ManageData key/value protocol bounds.
export type DataInput = string | Uint8Array | { encoding: 'utf8' | 'hex' | 'base64'; data: string };
export interface DataProposal { accountId: string; key: string; value?: DataInput }
export function decodeData(value: DataInput): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  const data = typeof value === 'string' ? value : value.data;
  const encoding = typeof value === 'string' ? 'utf8' : value.encoding;
  if (typeof data !== 'string') throw new Error('Data value must be text or bytes');
  if (encoding === 'utf8') {
    // Reject unpaired surrogate characters, which Buffer would silently replace.
    if (/\p{Surrogate}/u.test(data.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
      throw new Error('Value contains invalid UTF-16 surrogate');
    }
    return Buffer.from(data, 'utf8');
  }
  if (encoding === 'hex') {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('Invalid hex encoding');
    return Buffer.from(data, 'hex');
  }
  if (encoding === 'base64') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error('Invalid base64 encoding');
    }
    return Buffer.from(data, 'base64');
  }
  throw new Error('Unsupported value encoding');
}
export function validateDataInput(key: string, value?: DataInput) {
  const errors: string[] = [];
  const keyBytes = typeof key === 'string' ? Buffer.byteLength(key, 'utf8') : 0;
  if (!keyBytes || keyBytes > MAX_DATA_BYTES) errors.push('Key must be 1–64 UTF-8 bytes');
  if (typeof key === 'string' && /\p{Surrogate}/u.test(key.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) errors.push('Key has invalid Unicode');
  let valueBytes: number | null = null;
  let base64: string | null = null;
  if (value !== undefined) {
    try {
      const bytes = decodeData(value);
      valueBytes = bytes.length;
      base64 = bytes.toString('base64');
      if (bytes.length > MAX_DATA_BYTES) errors.push('Value cannot exceed 64 encoded bytes');
    } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
  }
  return { valid: errors.length === 0, errors, keyBytes, valueBytes, base64, removal: value === undefined };
}
export function inspectDataProposal(proposal: DataProposal, acc: Account | null, baseReserveStroops?: string | bigint) {
  const input = validateDataInput(proposal.key, proposal.value);
  const errors = [...input.errors];
  const warnings: string[] = [];
  if (!acc) errors.push('Account missing or could not be retrieved; cannot confirm account-data state');
  if (acc && acc.account_id !== proposal.accountId) errors.push('Account response does not match requested ID');
  const data = acc?.data;
  if (!data) warnings.push('Account data listing missing; existing-key state is unknown');
  const existing: boolean | null = data ? Object.prototype.hasOwnProperty.call(data, proposal.key) : null;
  const operation = input.removal ? 'remove' : existing === true ? 'update' : existing === false ? 'create' : 'unknown';
  if (input.removal && existing === false) errors.push('Cannot remove a data key that does not exist');
  let reserveDeltaXlm: string | null = null;
  if (acc && baseReserveStroops !== undefined) {
    const base = stroops(baseReserveStroops);
    try {
      const bal = nativeBalance(acc);
      if (typeof acc.subentry_count !== 'number' || typeof acc.num_sponsoring !== 'number' || typeof acc.num_sponsored !== 'number') {
        warnings.push('Reserve counters missing; cannot assess spending readiness');
      } else if (existing !== null) {
        const reserveUnits = 2n + BigInt(acc.subentry_count) + BigInt(acc.num_sponsoring) - BigInt(acc.num_sponsored);
        if (reserveUnits < 0n) throw new Error('Negative reserve units');
        const minimum = reserveUnits * base;
        const delta = operation === 'create' ? base : operation === 'remove' ? -base : 0n;
        reserveDeltaXlm = unitsToAmount(delta); // Estimate only; sponsored data entries may differ.
        if (bal.balance - bal.sellingLiabilities < minimum + delta) warnings.push('Potential insufficient XLM after reserve and selling liabilities');
      }
    } catch (error) { warnings.push(`Cannot estimate XLM readiness: ${String(error)}`); }
  } else warnings.push('Reserve/fee readiness not verified; provide current reserve source and account metadata');
  warnings.push('Network transaction fee and authorization checks are separate; local validation does not guarantee success.');
  return {
    accountId: proposal.accountId, key: proposal.key, operation, existingKey: existing,
    encodedKeyBytes: input.keyBytes, encodedValueBytes: input.valueBytes,
    encodedValueBase64: input.base64, reserveDeltaXlm,
    localValid: errors.length === 0 && existing !== null,
    errors, warnings,
  };
}
