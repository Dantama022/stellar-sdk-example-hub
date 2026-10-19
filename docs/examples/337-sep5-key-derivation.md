# ISSUE-337 — SEP-5 Wallet Key Derivation

SEP-5 specifies BIP-39 mnemonic -> PBKDF2-HMAC-SHA512 seed -> SLIP-0010 ed25519 hardened derivation at `m/44'/148'/x'` (Stellar SLIP-0044 coin type 148) -> 32-byte private seed -> Stellar Ed25519 keypair/public StrKey `G...`. The primary account is `m/44'/148'/0'`. Different paths yield different keys.

## Run offline

```bash
npx ts-node src/examples/337-sep5-key-derivation.ts
# optional: SEP5_ACCOUNT_INDEX=1
```

Uses only existing `@stellar/stellar-sdk` and Node `crypto` APIs; no network, funded account, real wallet or added dependency. The sole runtime fixture is the **published SEP-5 public test mnemonic**, which MUST NEVER secure funds. The code deliberately prints only the derived **public** address.

```text
SEP-5 hardened derivation path: m/44'/148'/0'
Derived public Stellar address: GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6
Offline derivation complete. No mnemonic, seed or secret key printed or sent.
```

**Important limitation:** To avoid adding a full BIP-39 wordlist/dependency, this educational derivation checks word counts and alphabetic form but **does not validate the BIP-39 2048-word dictionary or checksum**. Production wallets must use an audited full BIP-39 validator (including proper passphrase rules) and secure key storage. Do not feed actual wallet mnemonic material to tutorials. Never print, transmit or commit real mnemonic/seed/secret material. A correctly derived account address does **not** prove the account is funded, activated or controlled by someone.

Public reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md ; https://github.com/satoshilabs/slips/blob/master/slip-0010.md ; https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
