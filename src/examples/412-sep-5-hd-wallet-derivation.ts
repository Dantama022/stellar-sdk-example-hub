import { createHash, createHmac, pbkdf2Sync } from 'crypto';
import { readFileSync } from 'fs';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

/** SEP-5 uses the Stellar coin type 148 with BIP-44-style hardened indexes. */
export const SEP5_PURPOSE = 44;
export const SEP5_COIN_TYPE = 148;
export const SEP5_PATH_PREFIX = "m/44'/148'";
const HARDENED_OFFSET = 0x80000000;

export interface MnemonicValidation {
  valid: boolean;
  wordCount: number;
  checksumVerified: boolean;
  reason: string | null;
}

export interface DerivationReport {
  standard: 'SEP-5';
  derivationPath: string;
  accountIndex: number;
  mnemonicValidation: MnemonicValidation;
  derivedPublicKey: string | null;
  publicKeyValid: boolean;
  recoveryConsistent: boolean;
  securityWarnings: string[];
}

export function isValidAccountIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < HARDENED_OFFSET;
}

export function derivationPath(index: number): string {
  if (!isValidAccountIndex(index)) throw new Error('Invalid SEP-5 account index.');
  return `${SEP5_PATH_PREFIX}/${index}'`;
}

/**
 * Validates a BIP-39 mnemonic. Structural checks always run; checksum
 * verification requires the official BIP-39 English wordlist, supplied by the
 * caller, so no recovery phrase is ever sent anywhere for validation.
 */
export function validateMnemonic(
  mnemonic: string,
  wordlist?: string[],
): MnemonicValidation {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const base: MnemonicValidation = {
    valid: false,
    wordCount,
    checksumVerified: false,
    reason: null,
  };

  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    return { ...base, reason: 'A BIP-39 mnemonic must contain 12, 15, 18, 21 or 24 words.' };
  }
  if (words.some((word) => !/^[a-z]+$/.test(word))) {
    return { ...base, reason: 'Mnemonic words must be lowercase BIP-39 English words.' };
  }
  if (!wordlist) {
    return { ...base, reason: 'Checksum not verified: no BIP-39 wordlist was supplied.' };
  }
  if (wordlist.length !== 2048) {
    return { ...base, reason: 'The supplied BIP-39 wordlist must contain 2048 words.' };
  }

  const indexes = words.map((word) => wordlist.indexOf(word));
  if (indexes.some((index) => index < 0)) {
    return { ...base, reason: 'A word is not in the supplied BIP-39 wordlist.' };
  }

  const entropyBits = (wordCount * 11 * 32) / 33;
  const checksumBits = wordCount * 11 - entropyBits;
  const bits = indexes
    .map((index) => index.toString(2).padStart(11, '0'))
    .join('');
  const entropyBytes = Buffer.alloc(entropyBits / 8);
  for (let byte = 0; byte < entropyBytes.length; byte += 1) {
    entropyBytes[byte] = parseInt(bits.slice(byte * 8, byte * 8 + 8), 2);
  }
  const digest = createHash('sha256').update(entropyBytes).digest();
  const expectedChecksum = digest[0] >> (8 - checksumBits);
  const actualChecksum = parseInt(bits.slice(entropyBits), 2);

  return {
    valid: expectedChecksum === actualChecksum,
    wordCount,
    checksumVerified: true,
    reason:
      expectedChecksum === actualChecksum ? null : 'BIP-39 checksum does not match the entropy.',
  };
}

/** Converts a mnemonic and optional passphrase into a 64-byte BIP-39 seed. */
export function deriveSeed(mnemonic: string, passphrase = ''): Buffer {
  const normalizedMnemonic = mnemonic.normalize('NFKD');
  const normalizedPassphrase = `mnemonic${passphrase}`.normalize('NFKD');
  return pbkdf2Sync(normalizedMnemonic, normalizedPassphrase, 2048, 64, 'sha512');
}

interface HdKey {
  key: Buffer;
  chainCode: Buffer;
}

/**
 * SLIP-0010 hardened derivation used by SEP-5 for m/44'/148'/index'.
 * Only public keys are reported; intermediate private material stays local.
 */
export function deriveStellarKeypair(seed: Buffer, accountIndex: number): Keypair {
  if (!Buffer.isBuffer(seed) || seed.length === 0) {
    throw new Error('Invalid BIP-39 seed material.');
  }
  if (!isValidAccountIndex(accountIndex)) throw new Error('Invalid SEP-5 account index.');

  const master = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let current: HdKey = { key: master.subarray(0, 32), chainCode: master.subarray(32) };

  for (const hardenedIndex of [SEP5_PURPOSE, SEP5_COIN_TYPE, accountIndex]) {
    const index = hardenedIndex | HARDENED_OFFSET;
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32BE(index, 0);
    const derived = createHmac('sha512', current.chainCode)
      .update(Buffer.concat([Buffer.from([0]), current.key, indexBytes]))
      .digest();
    current = { key: derived.subarray(0, 32), chainCode: derived.subarray(32) };
  }

  return Keypair.fromRawEd25519Seed(current.key);
}

export function buildDerivationReport(
  accountIndex: number,
  validation: MnemonicValidation,
  mnemonic: string,
  passphrase = '',
): DerivationReport {
  const path = derivationPath(accountIndex);
  const publicKey = validation.valid
    ? deriveStellarKeypair(deriveSeed(mnemonic, passphrase), accountIndex).publicKey()
    : null;
  const again = validation.valid
    ? deriveStellarKeypair(deriveSeed(mnemonic, passphrase), accountIndex).publicKey()
    : null;

  return {
    standard: 'SEP-5',
    derivationPath: path,
    accountIndex,
    mnemonicValidation: validation,
    derivedPublicKey: publicKey,
    publicKeyValid: publicKey !== null && StrKey.isValidEd25519PublicKey(publicKey),
    recoveryConsistent: publicKey !== null && publicKey === again,
    securityWarnings: [
      'Use only test-only mnemonics here; never use real recovery material.',
      'Mnemonic, seed and secret key are never printed or transmitted.',
      'Publishes only the derived G... public key.',
    ],
  };
}

export function formatTextReport(report: DerivationReport): string {
  return [
    '=== SEP-5 HD Wallet Derivation ===',
    `Derivation standard: ${report.standard}`,
    `Derivation path: ${report.derivationPath}`,
    `Account index: ${report.accountIndex}`,
    `Mnemonic valid: ${report.mnemonicValidation.valid}`,
    `Checksum verified: ${report.mnemonicValidation.checksumVerified}`,
    `Mnemonic issue: ${report.mnemonicValidation.reason ?? 'none'}`,
    `Derived public key: ${report.derivedPublicKey ?? 'unavailable'}`,
    `Public-key encoding valid: ${report.publicKeyValid}`,
    `Recovery consistent: ${report.recoveryConsistent}`,
    '',
    'Security warnings:',
    ...report.securityWarnings.map((warning) => `  - ${warning}`),
  ].join('\n');
}

export function toJson(report: DerivationReport): string {
  return JSON.stringify(report, null, 2);
}

/** Loads a wordlist file when the caller wants full BIP-39 checksum validation. */
function loadWordlist(path: string | undefined): string[] | undefined {
  if (!path) return undefined;
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export async function run(
  params: {
    mnemonic?: string;
    accountIndex?: number;
    passphrase?: string;
    wordlistPath?: string;
    json?: boolean;
  } = {},
): Promise<void> {
  // The mnemonic is read from an argument or environment only; it is never logged.
  const mnemonic = params.mnemonic ?? process.env.SEP5_TEST_MNEMONIC ?? '';
  if (!mnemonic) {
    throw new Error('A test-only mnemonic is required (SEP5_TEST_MNEMONIC).');
  }
  const index = params.accountIndex ?? Number(process.env.SEP5_ACCOUNT_INDEX ?? 0);
  if (!isValidAccountIndex(index)) throw new Error('Invalid SEP-5 account index.');

  const validation = validateMnemonic(
    mnemonic,
    loadWordlist(params.wordlistPath ?? process.env.BIP39_WORDLIST_PATH),
  );
  const report = buildDerivationReport(index, validation, mnemonic, params.passphrase ?? '');
  const asJson = params.json === true || process.env.JSON_OUTPUT === 'true';
  console.log(asJson ? toJson(report) : formatTextReport(report));
}
