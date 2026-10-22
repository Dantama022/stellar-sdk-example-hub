# ISSUE-007: Add Asset Issuance and Lock Issuer Account Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

To issue a custom asset on Stellar, you create an issuer account and a distribution account. To guarantee the supply remains fixed or to trust the asset, it is common to "lock" the issuer account by setting its master weight to 0.

We need a script executing this exact pattern.

## Tasks

- [ ] Create `src/examples/12-asset-issuance.ts`
- [ ] Create issuer and distributor keypairs
- [ ] Establish trustline from distributor to custom asset
- [ ] Perform payment from issuer to distributor (creating initial supply)
- [ ] Lock issuer account (masterWeight: 0, thresholds: low=0, med=0, high=0)
- [ ] Register in runner

## Acceptance Criteria

- Runs fully on testnet using `npm run run-example 12-asset-issuance`
- Verifies issuer is locked (cannot sign further transactions)
- Explains safety and security implications
