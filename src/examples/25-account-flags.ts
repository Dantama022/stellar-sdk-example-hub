import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  AuthRequiredFlag,
  AuthRevocableFlag,
} from '@stellar/stellar-sdk';

/**
 * Account Flags Example
 *
 * This example demonstrates how to view and modify account flags using the
 * `setOptions` operation. Account flags control asset authorization behavior
 * for issuer accounts on Stellar.
 *
 * Available flags:
 * ────────────────
 * • AUTH_REQUIRED (0x1):
 *   When set on an issuer account, any account that wants to hold the issuer's
 *   asset must first be explicitly authorized by the issuer (via `allowTrust`
 *   or `setTrustLineFlags`). This enables compliance workflows where the issuer
 *   must approve holders before they can receive the asset.
 *
 * • AUTH_REVOCABLE (0x2):
 *   When set alongside AUTH_REQUIRED, the issuer can revoke an account's
 *   authorization to hold the asset at any time. This allows the issuer to
 *   freeze assets for regulatory compliance. Without this flag, once authorized,
 *   an account can hold the asset indefinitely.
 *
 * • AUTH_IMMUTABLE (0x4):
 *   When set, the issuer can NEVER change any of its own flags again. This is
 *   an irreversible operation — once AUTH_IMMUTABLE is set, the authorization
 *   configuration is permanently locked. Use with extreme caution:
 *   - The issuer cannot later add AUTH_REQUIRED or AUTH_REVOCABLE.
 *   - The issuer cannot remove AUTH_IMMUTABLE once it is set.
 *   - This signals to holders that the authorization model will never change.
 *
 * Issuer behavior & authorization models:
 * ────────────────────────────────────────
 * - No flags: Open issuance — anyone can create a trustline and receive tokens.
 * - AUTH_REQUIRED only: Gated issuance — issuer must approve each holder.
 * - AUTH_REQUIRED + AUTH_REVOCABLE: Full compliance — issuer can approve and
 *   revoke authorization (freeze/unfreeze assets).
 * - AUTH_IMMUTABLE: Locked — signals permanence; no future flag changes allowed.
 *
 * Workflow:
 *   1. Fund an issuer account
 *   2. Display current flags (expect none set on a fresh account)
 *   3. Set AUTH_REQUIRED and AUTH_REVOCABLE flags
 *   4. Query and verify updated flags
 *   5. Print before/after state and transaction hash
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Account Flags Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  // 1. Generate and fund an issuer account
  const issuer = Keypair.random();
  console.log(`\nIssuer Public Key: ${issuer.publicKey()}`);

  console.log('Funding issuer account via Friendbot...');
  const fundResponse = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`,
  );
  if (!fundResponse.ok) {
    throw new Error(`Failed to fund issuer: ${fundResponse.statusText}`);
  }
  console.log('Issuer account funded successfully.');

  // 2. Display current flags (before state)
  console.log('\n--- Before: Current Account Flags ---');
  const accountBefore = await server.loadAccount(issuer.publicKey());
  const flagsBefore = accountBefore.flags;
  console.log(`  auth_required:  ${flagsBefore.auth_required}`);
  console.log(`  auth_revocable: ${flagsBefore.auth_revocable}`);
  console.log(`  auth_immutable: ${flagsBefore.auth_immutable}`);

  // 3. Update flags using setOptions
  //    Enable AUTH_REQUIRED and AUTH_REVOCABLE to create a controlled
  //    authorization model where the issuer can approve and revoke holders.
  //    NOTE: We intentionally do NOT set AUTH_IMMUTABLE here because it is
  //    irreversible — once set, the issuer can never modify flags again.
  console.log('\n--- Setting Account Flags ---');
  console.log('Enabling: AUTH_REQUIRED + AUTH_REVOCABLE');
  const setFlagsAccount = await server.loadAccount(issuer.publicKey());
  const setFlagsTx = new TransactionBuilder(setFlagsAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        setFlags: AuthRequiredFlag | AuthRevocableFlag,
      }),
    )
    .setTimeout(30)
    .build();

  setFlagsTx.sign(issuer);
  const flagsResult = await server.submitTransaction(setFlagsTx);
  console.log(`Set flags transaction hash: ${flagsResult.hash}`);

  // 4. Query account again and verify updated flags
  console.log('\n--- After: Updated Account Flags ---');
  const accountAfter = await server.loadAccount(issuer.publicKey());
  const flagsAfter = accountAfter.flags;
  console.log(`  auth_required:  ${flagsAfter.auth_required}`);
  console.log(`  auth_revocable: ${flagsAfter.auth_revocable}`);
  console.log(`  auth_immutable: ${flagsAfter.auth_immutable}`);

  // 5. Summary comparison
  console.log('\n--- Flags Comparison ---');
  console.log(`  auth_required:  ${flagsBefore.auth_required} → ${flagsAfter.auth_required}`);
  console.log(`  auth_revocable: ${flagsBefore.auth_revocable} → ${flagsAfter.auth_revocable}`);
  console.log(`  auth_immutable: ${flagsBefore.auth_immutable} → ${flagsAfter.auth_immutable}`);

  // Demonstrate that AUTH_IMMUTABLE is irreversible by explaining (not executing)
  console.log('\n--- Important Note on AUTH_IMMUTABLE ---');
  console.log('Setting AUTH_IMMUTABLE is IRREVERSIBLE. Once set:');
  console.log('  - No flags can ever be changed again on this account.');
  console.log('  - The authorization model is permanently locked.');
  console.log('  - This is typically done as a final step after all configuration');
  console.log('    is complete, to signal permanence to asset holders.');
  console.log('  (Not demonstrated here to keep the account usable for further testing.)');

  console.log('\nAccount Flags example completed successfully.');
}
