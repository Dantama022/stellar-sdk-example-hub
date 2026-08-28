import {
  Asset,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Offline Transaction Preparation Workflow Example
 *
 * Many production applications keep signing keys on an isolated, "air-gapped"
 * machine that never touches the network. A separate, network-connected
 * machine prepares an unsigned transaction, serializes it to XDR, and hands
 * that XDR over to the offline machine (e.g. via a QR code, a USB drive, or a
 * hardware wallet). The offline machine signs the transaction and returns the
 * signed XDR, which the online machine then reconstructs and submits.
 *
 * This example walks through the complete round trip:
 *
 *   1. Build an unsigned payment transaction (online machine)
 *   2. Serialize it to XDR and simulate handing it to an offline environment
 *   3. Sign the transaction offline and serialize the signed result back
 *   4. Demonstrate graceful handling of corrupted/invalid XDR
 *   5. Reconstruct the signed transaction and submit it to the network
 *   6. Explain when and why offline signing should be used
 *
 * See also `src/examples/17-offline-signing.ts` for a simpler offline sign
 * and submit flow. This example adds a fuller multi-phase narrative and,
 * critically, demonstrates how to detect and reject corrupted XDR instead of
 * letting a low-level parsing exception crash the workflow.
 */

/**
 * Reconstructs a `Transaction` from its XDR representation.
 *
 * Wraps `TransactionBuilder.fromXDR` and adds two safety guarantees that raw
 * SDK usage does not provide out of the box:
 *
 *   - Rejects fee-bump transaction envelopes with a clear error, since this
 *     workflow only deals in plain `Transaction`s.
 *   - Catches any low-level XDR decoding failure (malformed base64, truncated
 *     buffers, bad discriminants, etc.) and rethrows it as a single,
 *     descriptive `Error` with the greppable prefix
 *     `"Invalid or corrupted transaction XDR"` instead of letting a cryptic
 *     stack trace from the XDR layer propagate to the caller.
 */
export function reconstructTransactionFromXDR(xdr: string, networkPassphrase: string): Transaction {
  let parsed: Transaction | FeeBumpTransaction;

  try {
    parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid or corrupted transaction XDR: ${message}`);
  }

  if (parsed instanceof FeeBumpTransaction) {
    throw new Error(
      'Invalid or corrupted transaction XDR: expected a standard Transaction, ' +
        'but decoded a FeeBumpTransaction instead',
    );
  }

  return parsed;
}

/**
 * A lightweight, pre-flight sanity check for a transaction XDR string.
 *
 * This does NOT replace `reconstructTransactionFromXDR`'s try/catch — a
 * string can pass this check and still fail full reconstruction (or vice
 * versa a string with unusual-but-valid padding could fail this heuristic).
 * It exists to demonstrate a cheap first line of defense before attempting
 * the more expensive full XDR decode, and to give callers a boolean check
 * they can branch on.
 */
export function isLikelyCorruptedXDR(xdr: string): boolean {
  if (!xdr || typeof xdr !== 'string') {
    return true;
  }

  const trimmed = xdr.trim();
  if (trimmed.length === 0) {
    return true;
  }

  // Transaction envelope XDR is base64-encoded. Base64 strings must have a
  // length that is a multiple of 4 (with '=' padding) and may only contain
  // base64 alphabet characters.
  const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Pattern.test(trimmed) || trimmed.length % 4 !== 0) {
    return true;
  }

  try {
    Buffer.from(trimmed, 'base64');
    return false;
  } catch {
    return true;
  }
}

/**
 * Signs an unsigned transaction XDR string with the supplied keypair,
 * simulating the "offline device" step of the workflow: the offline machine
 * receives only the XDR (never a live network connection), reconstructs the
 * transaction locally, signs it with the private key it holds, and returns
 * the signed XDR for transport back to the online machine.
 */
export function signOffline(
  unsignedXdr: string,
  networkPassphrase: string,
  offlineKeypair: Keypair,
): string {
  const tx = reconstructTransactionFromXDR(unsignedXdr, networkPassphrase);
  tx.sign(offlineKeypair);
  return tx.toXDR();
}

/**
 * Produces a small, display- and test-friendly summary of a transaction.
 */
export function describeTransaction(tx: Transaction): {
  source: string;
  sequence: string;
  signatureCount: number;
  operationCount: number;
} {
  return {
    source: tx.source,
    sequence: tx.sequence,
    signatureCount: tx.signatures.length,
    operationCount: tx.operations.length,
  };
}

/**
 * Deliberately corrupts a valid XDR string so the workflow can demonstrate
 * graceful error handling. Truncating the base64 payload reliably breaks
 * decoding without ever accidentally producing another valid transaction.
 */
function corruptXdr(xdr: string): string {
  return xdr.slice(0, -10);
}

/**
 * Runs the offline transaction preparation workflow example.
 *
 * @param params Optional parameters for the payment amount.
 */
export async function run(params?: { amount?: string }): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const networkPassphrase = Networks.TESTNET;
  const server = new Horizon.Server(horizonUrl);

  const amount = params?.amount || '10';

  console.log(chalk.bold('Offline Transaction Preparation Workflow Example'));
  console.log(
    chalk.gray('Build → export XDR → air-gap to an offline signer → sign → reconstruct → submit.'),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Setup: generate keypairs and fund the source account
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Generating keypairs...'));
  const sourceKeypair = Keypair.random();
  const destinationKeypair = Keypair.random();

  console.log(`Source (online prep machine holds public key only): ${sourceKeypair.publicKey()}`);
  console.log(
    `Destination:                                        ${destinationKeypair.publicKey()}`,
  );

  console.log(chalk.yellow('\nStep 2: Funding source account via Friendbot...'));
  const fundRes = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(sourceKeypair.publicKey())}`,
  );
  if (!fundRes.ok) {
    throw new Error(`Failed to fund source account: ${fundRes.statusText}`);
  }
  console.log(chalk.green('Source account funded successfully.'));

  console.log(chalk.yellow('\nStep 3: Loading source account from Horizon...'));
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1: Prepare (online machine)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n--- Phase 1: Prepare unsigned transaction (online machine) ---'));

  const unsignedTx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationKeypair.publicKey(),
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  const unsignedXdr = unsignedTx.toXDR();
  const unsignedSummary = describeTransaction(unsignedTx);

  console.log('The online machine builds the transaction but never signs it — it does not');
  console.log('need access to the private key at all.');
  console.log(`\nUnsigned Transaction XDR:\n${unsignedXdr}`);
  console.log('\nUnsigned Transaction Summary:');
  console.log(`  - Source Account:   ${unsignedSummary.source}`);
  console.log(`  - Sequence Number:  ${unsignedSummary.sequence}`);
  console.log(`  - Operation Count:  ${unsignedSummary.operationCount}`);
  console.log(`  - Signature Count:  ${unsignedSummary.signatureCount}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2: Transfer to offline environment
  // ──────────────────────────────────────────────────────────────────────────
  console.log(
    chalk.bold.cyan('\n--- Phase 2: Transfer XDR to the offline environment (air-gapped) ---'),
  );
  console.log(
    'In a real deployment the unsigned XDR string above would now travel to an\n' +
      'air-gapped machine over a one-way channel — a QR code, a USB drive, or a\n' +
      "hardware wallet's serial link — never over a network connection. This\n" +
      'example simulates that transfer in-process by reusing the same XDR string.',
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 3: Offline signing
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n--- Phase 3: Sign offline ---'));
  console.log('The offline machine reconstructs the transaction from XDR and signs it');
  console.log('using a private key that has never touched a network-connected device.');

  const signedXdr = signOffline(unsignedXdr, networkPassphrase, sourceKeypair);
  const signedTx = reconstructTransactionFromXDR(signedXdr, networkPassphrase);
  const signedSummary = describeTransaction(signedTx);

  console.log(`\nSigned Transaction XDR:\n${signedXdr}`);
  console.log('\nSigned Transaction Summary:');
  console.log(`  - Source Account:   ${signedSummary.source}`);
  console.log(`  - Sequence Number:  ${signedSummary.sequence}`);
  console.log(`  - Operation Count:  ${signedSummary.operationCount}`);
  console.log(`  - Signature Count:  ${chalk.green(String(signedSummary.signatureCount))}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 4: Corrupted XDR demo
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n--- Phase 4: Handling corrupted XDR gracefully ---'));
  console.log(
    'Transport of XDR between machines is not immune to bit rot, truncation, or\n' +
      'human error (a partially scanned QR code, a copy/paste mistake, etc.). The\n' +
      'workflow must reject bad input cleanly instead of crashing.',
  );

  const corruptedSignedXdr = corruptXdr(signedXdr);
  console.log(`\nDeliberately corrupted XDR (truncated):\n${corruptedSignedXdr}`);

  if (isLikelyCorruptedXDR(corruptedSignedXdr)) {
    console.log(chalk.yellow('Pre-flight check: XDR failed the basic sanity check.'));
  }

  try {
    reconstructTransactionFromXDR(corruptedSignedXdr, networkPassphrase);
    console.log(
      chalk.red(
        'Unexpected: corrupted XDR was reconstructed without error. This should not happen.',
      ),
    );
  } catch (err: any) {
    console.log(chalk.green('Corrupted XDR was rejected gracefully:'));
    console.log(chalk.gray(`  ${err.message}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 5: Reconstruct and submit (online machine)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n--- Phase 5: Reconstruct signed transaction and submit ---'));
  console.log('The signed XDR travels back to the online machine, which reconstructs it');
  console.log('and submits it to the network — it never had access to the private key.');

  const response = await server.submitTransaction(signedTx);
  console.log(chalk.green('\nTransaction submitted and confirmed successfully!'));
  console.log(`Transaction Hash: ${chalk.bold(response.hash)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Best practices
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n--- Best Practices for Offline Signing ---'));
  console.log(
    '  • Keep signing keys on hardware wallets or cold-storage machines that never\n' +
      "    connect to the internet — minimize the private key's network exposure.\n" +
      '  • Transfer transaction XDR across the air gap using one-way media (QR codes,\n' +
      "    USB drives, or a hardware wallet's dedicated interface), not general-purpose\n" +
      '    network channels.\n' +
      '  • Always validate XDR before signing it — an offline signer should refuse to\n' +
      '    sign a transaction it cannot cleanly decode and inspect (source, sequence,\n' +
      '    operations, fee) rather than blindly signing opaque bytes.\n' +
      '  • Handle malformed or corrupted XDR gracefully at every hop; a single bad\n' +
      '    transfer should produce a clear error, not a crash or a silently accepted\n' +
      '    garbage transaction.\n' +
      '  • Use offline signing for high-value transfers, issuer/treasury operations,\n' +
      '    and any signer whose compromise would be catastrophic — the extra\n' +
      '    operational friction is the point.',
  );
}
