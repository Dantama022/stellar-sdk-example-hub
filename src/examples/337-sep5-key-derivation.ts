/** ISSUE-337: BIP-39 seed + SLIP-0010 hardened ed25519 derivation, SEP-5 path. Offline. */
import { createHmac, pbkdf2Sync } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

// PUBLICLY PUBLISHED SEP-5 test vector only; NEVER use this mnemonic to hold real funds.
export const TEST_MNEMONIC = 'illness spike retreat truth genius clock brain pass fit cave bargain toe';
export const SEP5_TEST_VECTOR_PUBLIC = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
export const PRIMARY_PATH = "m/44'/148'/0'";

/** Checks well-formed words/length. Full BIP-39 dictionary/checksum validation requires an audited wordlist. */
export function validateMnemonicShape(mnemonic: string): string {
  const normalized = mnemonic.normalize('NFKD').trim().replace(/\s+/g, ' ');
  const words = normalized.split(' ');
  if (![12, 15, 18, 21, 24].includes(words.length) || words.some(word => !/^[a-z]+$/.test(word))) {
    throw new Error('mnemonic must contain 12, 15, 18, 21 or 24 lowercase BIP-39 English words');
  }
  return normalized;
}

export function validatePath(path: string): number {
  const match = /^m\/44'\/148'\/(0|[1-9]\d*)'$/.exec(path);
  if (!match) throw new Error("SEP-5 path must be m/44'/148'/x' with a hardened nonnegative account index");
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index >= 0x80000000) throw new Error('SEP-5 account index exceeds 2^31-1');
  return index;
}

/** Derive a 32-byte seed for ed25519 using SLIP-0010. No mnemonic/secret is displayed or transmitted. */
export function derivePublicKey(mnemonic: string, path = PRIMARY_PATH, passphrase = ''): string {
  const phrase = validateMnemonicShape(mnemonic);
  const accountIndex = validatePath(path);
  const seed = pbkdf2Sync(phrase, `mnemonic${passphrase.normalize('NFKD')}`, 2048, 64, 'sha512');
  let digest = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let secret = digest.subarray(0, 32);
  let chainCode = digest.subarray(32);
  for (const segment of [44, 148, accountIndex]) {
    const payload = Buffer.alloc(37);
    payload[0] = 0;
    secret.copy(payload, 1);
    payload.writeUInt32BE(segment + 0x80000000, 33);
    digest = createHmac('sha512', chainCode).update(payload).digest();
    secret = digest.subarray(0, 32);
    chainCode = digest.subarray(32);
  }
  const publicKey = Keypair.fromRawEd25519Seed(secret).publicKey();
  if (!StrKey.isValidEd25519PublicKey(publicKey)) throw new Error('derived public key failed Stellar StrKey validation');
  return publicKey;
}

export async function run(): Promise<void> {
  const accountIndex = Number(process.env.SEP5_ACCOUNT_INDEX || '0');
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= 0x80000000) throw new Error('SEP5_ACCOUNT_INDEX must be 0..2147483647');
  const path = `m/44'/148'/${accountIndex}'`;
  // Example intentionally accepts ONLY the published fixture. Do not pass real wallet phrases to demo code.
  const publicKey = derivePublicKey(TEST_MNEMONIC, path);
  console.log(`SEP-5 hardened derivation path: ${path}`);
  console.log(`Derived public Stellar address: ${publicKey}`);
  if (accountIndex === 0 && publicKey !== SEP5_TEST_VECTOR_PUBLIC) throw new Error('public key does not match the official SEP-5 test vector');
  console.log('Offline derivation complete. No mnemonic, seed or secret key printed or sent.');
}
if (require.main === module) run().catch(err => { console.error(err instanceof Error ? err.message : 'SEP-5 derivation failed'); process.exitCode = 1; });
