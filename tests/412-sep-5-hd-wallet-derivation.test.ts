import { createHash } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  buildDerivationReport,
  deriveSeed,
  deriveStellarKeypair,
  derivationPath,
  formatTextReport,
  isValidAccountIndex,
  toJson,
  validateMnemonic,
} from '../src/examples/412-sep-5-hd-wallet-derivation';

// Synthetic BIP-39-style vectors: never commit real recovery material.
const WORDLIST = Array.from({ length: 2048 }, (_, index) => `w${index}`);

function mnemonicFromEntropy(entropy: Buffer): string {
  const checksumBits = (entropy.length * 8) / 32;
  const checksum = createHash('sha256').update(entropy).digest()[0] >> (8 - checksumBits);
  const bits =
    [...entropy].map((byte) => byte.toString(2).padStart(8, '0')).join('') +
    checksum.toString(2).padStart(checksumBits, '0');
  return Array.from({ length: bits.length / 11 }, (_, index) =>
    WORDLIST[parseInt(bits.slice(index * 11, index * 11 + 11), 2)],
  ).join(' ');
}

const MNEMONIC = mnemonicFromEntropy(Buffer.alloc(16));

describe('Issue #412: SEP-5 HD wallet derivation', () => {
  it('validates a synthetic BIP-39 mnemonic and rejects malformed input', () => {
    expect(validateMnemonic(MNEMONIC, WORDLIST)).toMatchObject({ valid: true, checksumVerified: true });
    expect(validateMnemonic('abandon abandon', WORDLIST).valid).toBe(false);
    expect(validateMnemonic(MNEMONIC.replace('w0', 'notaword'), WORDLIST).reason).toMatch(/wordlist/);
    expect(validateMnemonic(MNEMONIC.toUpperCase(), WORDLIST).valid).toBe(false);
    expect(validateMnemonic(MNEMONIC).checksumVerified).toBe(false);
  });

  it('uses the SEP-5 derivation path and validates account indexes', () => {
    expect(derivationPath(0)).toBe("m/44'/148'/0'");
    expect(derivationPath(7)).toBe("m/44'/148'/7'");
    expect(isValidAccountIndex(-1)).toBe(false);
    expect(isValidAccountIndex(0x80000000)).toBe(false);
    expect(() => derivationPath(-1)).toThrow(/account index/);
  });

  it('derives consistent public keys and distinct keys per index', () => {
    const seed = deriveSeed(MNEMONIC);
    expect(seed).toHaveLength(64);
    const first = deriveStellarKeypair(seed, 0);
    expect(first.publicKey()).toBe(deriveStellarKeypair(deriveSeed(MNEMONIC), 0).publicKey());
    expect(first.publicKey()).not.toBe(deriveStellarKeypair(seed, 1).publicKey());
    expect(StrKey.isValidEd25519PublicKey(first.publicKey())).toBe(true);
    expect(() => deriveStellarKeypair(Buffer.alloc(0), 0)).toThrow(/seed/);
  });

  it('reports recovery consistency without exposing secret material', () => {
    const report = buildDerivationReport(0, validateMnemonic(MNEMONIC, WORDLIST), MNEMONIC);
    expect(report.recoveryConsistent).toBe(true);
    expect(report.publicKeyValid).toBe(true);
    expect(Keypair.fromPublicKey(report.derivedPublicKey as string).publicKey()).toBe(
      report.derivedPublicKey,
    );
    const json = toJson(report);
    expect(json).not.toContain(MNEMONIC);
    expect(json).not.toContain(deriveSeed(MNEMONIC).toString('hex'));
    expect(json).not.toContain(deriveSeed(MNEMONIC).subarray(0, 32).toString('hex'));
    expect(formatTextReport(report)).toContain('SEP-5');
  });

  it('does not derive keys from an invalid mnemonic', () => {
    const report = buildDerivationReport(0, validateMnemonic('bad', WORDLIST), 'bad');
    expect(report.derivedPublicKey).toBeNull();
    expect(report.publicKeyValid).toBe(false);
  });
});
