/**
 * Contract-spec inspection. Soroban Wasm contracts embed their interface in a custom
 * section named "contractspecv0" (a stream of XDR ScSpecEntry values). Reading it tells us
 * which token methods exist before we call them. Stellar Asset Contracts have no Wasm and
 * implement the token interface in the host.
 */
import { cereal, contract, xdr } from '@stellar/stellar-sdk';
import { InterfaceReport } from './types';

const SPEC_SECTION = 'contractspecv0';

function readLeb128(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated LEB128 value in Wasm');
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('LEB128 value too large in Wasm');
  }
  return { value: result, next: pos };
}

/** Extract the raw bytes of the contract-spec custom section from a Wasm binary. */
export function extractSpecSection(wasm: Buffer): Buffer | null {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('Not a Wasm binary');
  }
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos++];
    const size = readLeb128(wasm, pos);
    pos = size.next;
    const end = pos + size.value;
    if (end > wasm.length) throw new Error('Wasm section exceeds file length');
    if (id === 0) {
      const nameLen = readLeb128(wasm, pos);
      const nameStart = nameLen.next;
      const name = wasm.subarray(nameStart, nameStart + nameLen.value).toString('utf8');
      if (name === SPEC_SECTION) return wasm.subarray(nameStart + nameLen.value, end);
    }
    pos = end;
  }
  return null;
}

/** Decode the spec section and return its function entries. */
export function specFunctions(wasm: Buffer): xdr.ScSpecFunctionV0[] {
  const section = extractSpecSection(wasm);
  if (!section) throw new Error('Wasm has no contract spec section');
  const reader = new cereal.XdrReader(section);
  const entries: xdr.ScSpecEntry[] = [];
  // The SDK's typings declare read() with a Buffer, but the runtime takes an XdrReader
  // (this mirrors the SDK's own processSpecEntryStream, which is not publicly exported).
  const readEntry = (xdr.ScSpecEntry as unknown as { read(r: unknown): xdr.ScSpecEntry }).read;
  while (!reader.eof) entries.push(readEntry.call(xdr.ScSpecEntry, reader));
  return new contract.Spec(entries).funcs();
}

/** Expected input counts for the read-only methods this example uses. */
const EXPECTED_INPUTS = { balance: 1, allowance: 2, decimals: 0 } as const;

/** Compare spec functions to the expected token methods (by name and arity). */
export function reportFromFunctions(funcs: xdr.ScSpecFunctionV0[]): InterfaceReport {
  const has = (name: keyof typeof EXPECTED_INPUTS): boolean =>
    funcs.some((f) => f.name().toString() === name && f.inputs().length === EXPECTED_INPUTS[name]);
  return {
    source: 'contract_spec',
    methods: { balance: has('balance'), allowance: has('allowance'), decimals: has('decimals') },
  };
}

export const STELLAR_ASSET_REPORT: InterfaceReport = {
  source: 'stellar_asset',
  methods: { balance: true, allowance: true, decimals: true },
};

export const UNAVAILABLE_REPORT: InterfaceReport = { source: 'unavailable', methods: {} };
