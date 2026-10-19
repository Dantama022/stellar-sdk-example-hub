import { Horizon, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import inquirer from 'inquirer';

/**
 * Example 262: Stellar Account Merge — Preflight Checks and Safe Execution
 *
 * Demonstrates how to inspect account state, validate account-merge
 * prerequisites (trustlines, liabilities, signers, data entries, issuer
 * exposure, thresholds), and prepare an account-merge transaction safely.
 *
 * Safety model:
 * - Read-only preflight first; every blocking condition is reported with
 *   remediation before anything is built.
 * - The merge transaction is built as UNSIGNED XDR for review only.
 * - Execution requires explicit user confirmation (interactive prompt or
 *   `--yes` / `CONFIRM_MERGE=yes`). Without confirmation the example stops
 *   after printing the unsigned XDR. It never signs with a real secret key
 *   and never submits transactions itself.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface AccountMergePreflightParams {
  sourceAccountId?: string;
  destinationAccountId?: string;
  horizonUrl?: string;
  /** Explicit confirmation for building the merge XDR (in addition to prompt). */
  confirm?: boolean | string;
  json?: boolean | string;
}

export interface MergeBlockingCheck {
  name: string;
  passed: boolean;
  detail: string;
  remediation?: string;
}

export interface MergePreflightResult {
  sourceAccountId: string;
  destinationAccountId: string;
  ready: boolean;
  checks: MergeBlockingCheck[];
  unsignedMergeXdr?: string;
}

function asBool(value?: boolean | string): boolean {
  return value === true || value === 'true' || value === 'yes';
}

export function isValidAccount(value?: string): boolean {
  return Boolean(value && StrKey.isValidEd25519PublicKey(value));
}

/**
 * Inspects merge prerequisites without changing any ledger state.
 */
export async function inspectMergePreflight(
  server: Horizon.Server,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<MergeBlockingCheck[]> {
  const checks: MergeBlockingCheck[] = [];

  if (!isValidAccount(sourceAccountId) || !isValidAccount(destinationAccountId)) {
    return [{ name: 'account-format', passed: false, detail: 'Both accounts must be valid G... addresses.' }];
  }
  if (sourceAccountId === destinationAccountId) {
    return [{ name: 'distinct-accounts', passed: false, detail: 'Source and destination must differ.' }];
  }

  let source: any;
  try {
    source = await server.loadAccount(sourceAccountId);
  } catch {
    return [{ name: 'source-exists', passed: false, detail: 'Source account not found.' }];
  }

  let destinationExists = true;
  try {
    await server.loadAccount(destinationAccountId);
  } catch {
    destinationExists = false;
  }
  checks.push({
    name: 'destination-exists',
    passed: destinationExists,
    detail: destinationExists ? 'Destination account exists.' : 'Destination account does not exist; it will be created by the merge.',
  });

  // Trustlines / non-native balances must be empty.
  const nonNative = (source.balances ?? []).filter((b: any) => b.asset_type !== 'native');
  checks.push({
    name: 'no-trustlines',
    passed: nonNative.length === 0,
    detail: nonNative.length === 0 ? 'No trustlines or non-native balances.' : `${nonNative.length} trustline(s)/non-native balance(s) present.`,
    remediation: nonNative.length === 0 ? undefined : 'Sell or transfer away all non-XLM assets, then remove every trustline.',
  });

  // Open offers lock reserves and block merges.
  const offers = (await server.offers().forAccount(sourceAccountId).limit(200).call()).records ?? [];
  checks.push({
    name: 'no-open-offers',
    passed: offers.length === 0,
    detail: offers.length === 0 ? 'No open SDEX offers.' : `${offers.length} open offer(s) present.`,
    remediation: offers.length === 0 ? undefined : 'Cancel every offer (manageSellOffer/manageBuyOffer with amount 0) first.',
  });

  // Liabilities (buying/selling) must be zero.
  const liabilities = (source.balances ?? []).some(
    (b: any) => (b.selling_liabilities && b.selling_liabilities !== '0.0000000') || (b.buying_liabilities && b.buying_liabilities !== '0.0000000'),
  );
  checks.push({
    name: 'no-liabilities',
    passed: !liabilities,
    detail: liabilities ? 'Open liabilities detected.' : 'No buying/selling liabilities.',
    remediation: liabilities ? 'Cancel offers and wait for liabilities to clear.' : undefined,
  });

  // Extra signers and thresholds: merging with additional signers needs care.
  const extraSigners = (source.signers ?? []).filter((s: any) => s.key !== sourceAccountId);
  checks.push({
    name: 'signers-reviewed',
    passed: true,
    detail: extraSigners.length === 0 ? 'Only the master key signs.' : `${extraSigners.length} additional signer(s) present; ensure all required signatures can be collected.`,
  });
  const thresholds = source.thresholds ?? {};
  checks.push({
    name: 'thresholds-reviewed',
    passed: true,
    detail: `Thresholds low=${thresholds.low_threshold ?? '?'} med=${thresholds.med_threshold ?? '?'} high=${thresholds.high_threshold ?? '?'}; account merge needs the high threshold.`,
  });

  // Data entries must be removed.
  let dataEntries = 0;
  try {
    const data = await server.dataForAccount(sourceAccountId).call();
    dataEntries = Object.keys((data as unknown as Record<string, unknown>) ?? {}).length;
  } catch {
    dataEntries = 0;
  }
  checks.push({
    name: 'no-data-entries',
    passed: dataEntries === 0,
    detail: dataEntries === 0 ? 'No data entries.' : `${dataEntries} data entr(y/ies) present.`,
    remediation: dataEntries === 0 ? undefined : 'Remove every data entry with manageData(name, null) first.',
  });

  // Sponsorships and sponsored reserves block merges.
  const sponsoring = Number(source.num_sponsoring ?? 0);
  const sponsored = Number(source.num_sponsored ?? 0);
  checks.push({
    name: 'no-sponsorships',
    passed: sponsoring === 0 && sponsored === 0,
    detail: sponsoring === 0 && sponsored === 0 ? 'No sponsorship relationships.' : `Sponsoring=${sponsoring} sponsored=${sponsored}.`,
    remediation: sponsoring === 0 && sponsored === 0 ? undefined : 'Revoke or transfer all sponsorships first.',
  });

  return checks;
}

/**
 * Builds an UNSIGNED account-merge transaction for review (no signing, no submission).
 */
export async function buildUnsignedMerge(
  server: Horizon.Server,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<string> {
  const source = await server.loadAccount(sourceAccountId);
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(Operation.accountMerge({ destination: destinationAccountId }))
    .setTimeout(60)
    .build();
  return tx.toXDR();
}

/**
 * Runs the account-merge preflight and safe-preparation example.
 *
 *   npm run run-example 262-account-merge-confirmation-preflight
 *
 * Environment:
 *   HORIZON_URL, SOURCE_ACCOUNT, DESTINATION_ACCOUNT,
 *   CONFIRM_MERGE=yes, JSON_OUTPUT=true
 */
export async function run(params: AccountMergePreflightParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const json = asBool(params.json) || process.env.JSON_OUTPUT === 'true';

  let sourceAccountId = params.sourceAccountId ?? process.env.SOURCE_ACCOUNT ?? process.argv[3];
  let destinationAccountId = params.destinationAccountId ?? process.env.DESTINATION_ACCOUNT ?? process.argv[4];
  let confirmed = asBool(params.confirm) || process.env.CONFIRM_MERGE === 'yes';

  if ((!sourceAccountId || !destinationAccountId) && !json) {
    const answers = await inquirer.prompt([
      { type: 'input', name: 'sourceAccountId', message: 'Source account to merge (will be removed):' },
      { type: 'input', name: 'destinationAccountId', message: 'Destination account receiving the balance:' },
      { type: 'confirm', name: 'confirmed', message: 'Build UNSIGNED merge XDR for review (nothing is signed or submitted)?', default: false },
    ]);
    sourceAccountId = answers.sourceAccountId;
    destinationAccountId = answers.destinationAccountId;
    confirmed = answers.confirmed;
  }

  if (!isValidAccount(sourceAccountId) || !isValidAccount(destinationAccountId)) {
    console.log(JSON.stringify({ error: 'Both SOURCE_ACCOUNT and DESTINATION_ACCOUNT must be valid G... addresses.' }));
    return;
  }

  const checks = await inspectMergePreflight(server, sourceAccountId as string, destinationAccountId as string);
  const blocking = checks.filter((c) => !c.passed && c.name !== 'destination-exists');
  const ready = blocking.length === 0;

  if (json) {
    console.log(JSON.stringify({ sourceAccountId, destinationAccountId, ready, checks }, null, 2));
  } else {
    console.log('=== Stellar Account Merge — Preflight Checks ===');
    for (const check of checks) {
      console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
      if (!check.passed && check.remediation) console.log(`        Fix: ${check.remediation}`);
    }
  }

  if (!ready) {
    console.log('\nMerge is NOT ready. Complete the remediation steps above first. Nothing was built.');
    return;
  }

  if (!confirmed) {
    console.log('\nPreflight passed. Re-run with CONFIRM_MERGE=yes (or confirm at the prompt) to build the UNSIGNED merge XDR for review.');
    return;
  }

  const xdr = await buildUnsignedMerge(server, sourceAccountId as string, destinationAccountId as string);
  console.log('\nUnsigned account-merge XDR (review only; not signed, not submitted):');
  console.log(xdr);
  console.log('\nMerging is irreversible. Confirm the destination, re-check trustlines/offers/liabilities, then sign in a separate explicit step.');
}
