import { StrKey } from '@stellar/stellar-sdk';
import { derivePublicKey, PRIMARY_PATH, SEP5_TEST_VECTOR_PUBLIC, TEST_MNEMONIC, validateMnemonicShape, validatePath } from '../src/examples/337-sep5-key-derivation';

test('official SEP-5 test vector matches derived public key', () => {
  const key = derivePublicKey(TEST_MNEMONIC, PRIMARY_PATH);
  expect(key).toBe(SEP5_TEST_VECTOR_PUBLIC);
  expect(StrKey.isValidEd25519PublicKey(key)).toBe(true);
});

test('different hardened account paths yield distinct public keys', () => {
  expect(derivePublicKey(TEST_MNEMONIC, "m/44'/148'/1'")).not.toBe(SEP5_TEST_VECTOR_PUBLIC);
  expect(validatePath("m/44'/148'/1'")).toBe(1);
});

test.each(['invalid seed', 'not valid', 'ELEVEN words are not accepted', ''])('malformed mnemonic input rejected', phrase => {
  expect(() => validateMnemonicShape(phrase)).toThrow('mnemonic');
});

test.each(["m/44'/0'/0'", "m/44'/148'/1", "m/44'/148'/2147483648'", "m/44'/148'/-1'"])('non-SEP5 path rejected', path => {
  expect(() => validatePath(path)).toThrow();
});

test('example derives only a public key and not a secret', () => {
  const output = derivePublicKey(TEST_MNEMONIC);
  expect(output.startsWith('G')).toBe(true);
  expect(output).not.toContain(TEST_MNEMONIC);
});
