# SEP-5 HD Wallet Derivation (issue #412)

Offline demonstration of BIP-39 mnemonic validation and SEP-5 Stellar key
derivation for `m/44'/148'/index'`.

## Run

```bash
BIP39_WORDLIST_PATH=/path/to/bip39/english.txt \
SEP5_TEST_MNEMONIC="<test-only mnemonic>" SEP5_ACCOUNT_INDEX=0 \
npm run run-example -- 412-sep-5-hd-wallet-derivation
```

Add `JSON_OUTPUT=true` for machine-readable output. Use only synthetic,
test-only mnemonics. The mnemonic is read from the environment and is never
printed, persisted, or sent to any network service. No secret keys appear in
reports.

## What it reports

- Derivation standard, full path, and account index.
- BIP-39 word count, word membership, and checksum result (checksum verification
  requires an official 2048-word BIP-39 wordlist; without one, validation is
  structural and explicitly marked unverified).
- Derived `G...` public key, StrKey encoding check, and recovery consistency
  from repeating the same derivation.

## Sample output

```text
Derivation path: m/44'/148'/0'
Mnemonic valid: true
Checksum verified: true
Derived public key: GABCDE...
Recovery consistent: true
```

## Limitations

SEP-5 uses hardened SLIP-0010 derivation; generic BIP-44 software will not
necessarily produce the same keys. Different wallet implementations may derive
different accounts, so this example is not a substitute for a wallet's own
recovery flow. Tests use synthetic wordlist vectors, never real mnemonics.

See https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
and https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki.
