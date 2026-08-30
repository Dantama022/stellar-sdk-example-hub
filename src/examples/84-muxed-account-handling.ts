import { Keypair, MuxedAccount, Account, StrKey } from '@stellar/stellar-sdk';

export interface ParsedMuxedAccount {
  muxedAddress: string;
  baseAccount: string;
  muxedId: string;
}

/**
 * Creates a muxed (M...) address from a base G... account and a numeric ID.
 */
export function createMuxedAddress(baseAccountId: string, id: string): string {
  const account = new Account(baseAccountId, '0');
  return new MuxedAccount(account, id).accountId();
}

/**
 * Parses a muxed address into its underlying account ID and muxed identifier.
 */
export function parseMuxedAddress(muxedAddress: string): ParsedMuxedAccount {
  if (!StrKey.isValidMed25519PublicKey(muxedAddress)) {
    throw new Error(`Invalid muxed account address: ${muxedAddress}`);
  }

  const muxed = MuxedAccount.fromAddress(muxedAddress, '0');

  return {
    muxedAddress,
    baseAccount: muxed.baseAccount().accountId(),
    muxedId: muxed.id(),
  };
}

/**
 * Accepts either a G... or M... address and reports which format it is.
 */
export function describeAddress(address: string): string {
  if (StrKey.isValidMed25519PublicKey(address)) {
    const parsed = parseMuxedAddress(address);
    return `muxed account (base ${parsed.baseAccount}, id ${parsed.muxedId})`;
  }

  if (StrKey.isValidEd25519PublicKey(address)) {
    return 'regular Stellar account';
  }

  return 'invalid address';
}

/**
 * Runs the muxed account handling example.
 */
export async function run(): Promise<void> {
  console.log('Starting Muxed Account Handling Example...');

  const base = Keypair.random().publicKey();
  console.log(`\nBase account: ${base}`);

  for (const id of ['1', '42', '18446744073709551615']) {
    const muxedAddress = createMuxedAddress(base, id);
    const parsed = parseMuxedAddress(muxedAddress);

    console.log(`\nMuxed ID ${id}`);
    console.log(`  Address:      ${parsed.muxedAddress}`);
    console.log(`  Base account: ${parsed.baseAccount}`);
    console.log(`  Muxed ID:     ${parsed.muxedId}`);
  }

  console.log('\nAddress classification:');
  console.log(`  ${base} -> ${describeAddress(base)}`);
  console.log(`  GINVALID -> ${describeAddress('GINVALID')}`);

  try {
    parseMuxedAddress('MNOTREAL');
  } catch (error: any) {
    console.log(`\nHandled invalid muxed address: ${error.message}`);
  }

  console.log(
    '\nUse case: custodial platforms reuse one funded account and give each user a distinct',
  );
  console.log(
    'muxed ID, so deposits are attributed without paying reserves for one account per user.',
  );
  console.log('Muxed addresses can be used directly as payment source/destination values.');

  console.log('\nMuxed account handling completed successfully.');
}
