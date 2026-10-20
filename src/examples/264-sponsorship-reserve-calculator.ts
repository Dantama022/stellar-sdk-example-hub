/**
 * 264-sponsorship-reserve-calculator: Stellar Account Sponsorship Lifecycle and Signer Reserve Impact Calculator
 *
 * OVERVIEW
 * --------
 * Read-only example that inspects a Stellar account's sponsorship relationships
 * and estimates how sponsorship affects its minimum balance (reserve) obligations.
 *
 *   1. Retrieves the account's current state from Horizon.
 *   2. Identifies sponsored ledger entries visible on the account response
 *      (trustlines and signers carrying a sponsor field).
 *   3. Distinguishes entries sponsored by another account from entries the
 *      audited account itself sponsors.
 *   4. Estimates the minimum reserve using documented reserve rules and an
 *      explicit base-reserve value (from the latest ledger or supplied input).
 *
 * The result is clearly labeled an estimate: a single account query does not
 * reveal the full sponsorship graph, and only the ledger can produce an
 * authoritative minimum-balance calculation. No transactions are submitted and
 * no account configuration is modified.
 */

import { Horizon, Keypair } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const STROOPS_PER_XLM = 10_000_000;

export type SponsoredBy = 'this-account' | 'another-account' | 'unknown';

export interface SponsoredEntry {
  type: 'trustline' | 'signer';
  identifier: string; // asset code:issuer for trustlines, public key for signers
  sponsor: string | null;
  sponsoredBy: SponsoredBy;
  note: string;
}

export interface SponsorshipInspection {
  accountId: string;
  sponsor: string | null;
  numSponsored: number;
  numSponsoring: number;
  subentryCount: number;
  sponsoredEntries: SponsoredEntry[];
  sponsoredByOthers: number;
  sponsoredByThisAccount: number;
  unsupportedEntryTypes: string[];
}

export interface ReserveParameters {
  baseReserveStroops: number;
  baseReserveXlm: number;
  source: 'horizon-ledger' | 'supplied-input';
}

export interface ReserveCalculation {
  baseReserveStroops: number;
  baseReserveXlm: number;
  subentryCount: number;
  numSponsored: number;
  numSponsoring: number;
  effectiveSubentries: number;
  formula: string;
  minimumReserveStroops: number;
  minimumReserveXlm: number;
  nativeBalanceXlm?: number;
  estimatedAvailableXlm?: number;
  isEstimate: boolean;
}

export interface SponsorshipReport {
  account: SponsorshipInspection;
  reserve: ReserveParameters;
  calculation: ReserveCalculation;
  notes: string[];
}

export interface RunParams {
  accountId?: string;
  horizonUrl?: string;
  baseReserveStroops?: string;
  json?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────────────────────────

/** Validates a Stellar public key (ed25519, G-prefixed 56 characters). */
export function validateAccountPublicKey(accountId: string): string {
  const key = accountId.trim();
  if (key.length === 0) throw new Error('Missing account public key');
  try {
    Keypair.fromPublicKey(key);
  } catch {
    throw new Error(`Invalid Stellar account public key: ${accountId}`);
  }
  return key;
}

/** Parses an optional base-reserve override, in stroops. */
export function parseBaseReserve(input?: string): { value: number | null; error: string | null } {
  if (!input) return { value: null, error: null };
  const parsed = Number(input.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed % 1 !== 0) {
    return {
      value: null,
      error: `Base reserve must be a non-negative whole number of stroops, got: ${input}`,
    };
  }
  return { value: parsed, error: null };
}

// ──────────────────────────────────────────────────────────────────────────────
// Horizon data retrieval
// ──────────────────────────────────────────────────────────────────────────────

export interface HorizonAccountLike {
  id: string;
  sequence: string;
  subentry_count: number;
  num_sponsored: number;
  num_sponsoring: number;
  sponsor?: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    sponsor?: string;
  }>;
  signers: Array<{
    key: string;
    weight: number;
    type: string;
    sponsor?: string;
  }>;
  data: Record<string, string>;
}

export interface HorizonLedgerRecordLike {
  sequence: number;
  base_reserve_in_stroops: number;
}

/** Retrieves the base reserve from the latest closed ledger via Horizon. */
export async function fetchBaseReserveFromHorizon(server: Horizon.Server): Promise<number> {
  const page = await server.ledgers().limit(1).order('desc').call();
  const record = (page.records ?? [])[0] as HorizonLedgerRecordLike | undefined;
  if (!record || typeof record.base_reserve_in_stroops !== 'number') {
    throw new Error('Horizon did not return a base reserve value for the latest ledger.');
  }
  return record.base_reserve_in_stroops;
}

/** Resolves reserve parameters: explicit input takes precedence over Horizon. */
export async function resolveReserveParameters(
  server: Horizon.Server,
  input: { value: number | null; error: string | null },
): Promise<ReserveParameters> {
  if (input.error !== null) {
    throw new Error(input.error);
  }
  if (input.value !== null) {
    return {
      baseReserveStroops: input.value,
      baseReserveXlm: input.value / STROOPS_PER_XLM,
      source: 'supplied-input',
    };
  }

  const baseReserveStroops = await fetchBaseReserveFromHorizon(server);
  return {
    baseReserveStroops,
    baseReserveXlm: baseReserveStroops / STROOPS_PER_XLM,
    source: 'horizon-ledger',
  };
}

/**
 * Normalizes sponsorship information visible on a Horizon account response.
 *
 * Only trustlines (balances) and signers expose a sponsor field inline on the
 * account response. Data entries and offers do not, so they are listed as
 * unsupported entry types rather than guessed at.
 */
export function inspectSponsorship(account: HorizonAccountLike): SponsorshipInspection {
  const sponsoredEntries: SponsoredEntry[] = [];
  const seenTrustlines = new Set<string>();
  const seenSigners = new Set<string>();

  for (const balance of account.balances) {
    if (balance.asset_type === 'native') continue;
    if (!balance.sponsor) continue;
    const key = `${balance.asset_code}:${balance.asset_issuer}`;
    if (seenTrustlines.has(key)) continue;
    seenTrustlines.add(key);

    const sponsor = balance.sponsor;
    sponsoredEntries.push({
      type: 'trustline',
      identifier: key,
      sponsor,
      sponsoredBy: sponsor === account.id ? 'this-account' : 'another-account',
      note: `Trustline is sponsored by ${sponsor}`,
    });
  }

  for (const signer of account.signers) {
    if (!signer.sponsor) continue;
    if (seenSigners.has(signer.key)) continue;
    seenSigners.add(signer.key);

    const sponsor = signer.sponsor;
    sponsoredEntries.push({
      type: 'signer',
      identifier: signer.key,
      sponsor,
      sponsoredBy: sponsor === account.id ? 'this-account' : 'another-account',
      note: `Signer is sponsored by ${sponsor}`,
    });
  }

  const sponsoredByOthers = sponsoredEntries.filter(
    (e) => e.sponsoredBy === 'another-account',
  ).length;
  const sponsoredByThisAccount = sponsoredEntries.filter(
    (e) => e.sponsoredBy === 'this-account',
  ).length;

  return {
    accountId: account.id,
    sponsor: account.sponsor ?? null,
    numSponsored: account.num_sponsored,
    numSponsoring: account.num_sponsoring,
    subentryCount: account.subentry_count,
    sponsoredEntries,
    sponsoredByOthers,
    sponsoredByThisAccount,
    unsupportedEntryTypes: [
      'data entries (sponsorship not visible in inline account data)',
      'offers (sponsorship not visible in inline account response)',
      'claimable balances (not enumerated by this example)',
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Reserve calculation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Estimates the minimum reserve using the convention also used elsewhere in
 * this repository:
 *
 *   effectiveSubentries = 2 + subentry_count - num_sponsored + num_sponsoring
 *   minimumReserve      = effectiveSubentries * baseReserve
 *
 * The two base entries account for the account itself and its trustline
 * allowance. Entries sponsored by another account relieve the owner's reserve;
 * entries this account sponsors add to its obligations. This is an estimate:
 * Horizon's counters may not reflect the complete sponsorship graph.
 */
export function calculateReserve(
  inspection: SponsorshipInspection,
  reserve: ReserveParameters,
  nativeBalance?: string,
): ReserveCalculation {
  const { baseReserveStroops, baseReserveXlm } = reserve;
  const subentryCount = inspection.subentryCount;
  const numSponsored = inspection.numSponsored;
  const numSponsoring = inspection.numSponsoring;

  const effectiveSubentries = 2 + subentryCount - numSponsored + numSponsoring;
  const minimumReserveStroops = Math.max(0, effectiveSubentries) * baseReserveStroops;
  const minimumReserveXlm = minimumReserveStroops / STROOPS_PER_XLM;

  const calculation: ReserveCalculation = {
    baseReserveStroops,
    baseReserveXlm,
    subentryCount,
    numSponsored,
    numSponsoring,
    effectiveSubentries,
    formula: '(2 + subentry_count - num_sponsored + num_sponsoring) * base_reserve',
    minimumReserveStroops,
    minimumReserveXlm,
    isEstimate: true,
  };

  if (nativeBalance !== undefined && nativeBalance !== '') {
    const balance = Number(nativeBalance);
    if (Number.isFinite(balance)) {
      calculation.nativeBalanceXlm = balance;
      calculation.estimatedAvailableXlm = Math.max(0, balance - minimumReserveXlm);
    }
  }

  return calculation;
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly
// ──────────────────────────────────────────────────────────────────────────────

export function buildReport(
  account: SponsorshipInspection,
  reserve: ReserveParameters,
  calculation: ReserveCalculation,
): SponsorshipReport {
  const notes: string[] = [
    'This is a read-only, local estimate. No transaction was submitted and no account configuration was modified.',
    'The result is an ESTIMATE, not an authoritative ledger-level minimum balance.',
    'A single account query does not reveal the full sponsorship graph: entries',
    'sponsored by this account for other accounts, and the sponsorship of data',
    'entries and offers, are not fully visible here.',
    'Base reserve values are network-configured and may change; the value used',
    'above is explicitly sourced and should be re-checked before production use.',
    'Creating or removing sponsorship can have additional transaction-level',
    'requirements (fees, authorization, sequence numbers) outside this estimate.',
  ];

  if (reserve.source === 'supplied-input') {
    notes.push('Base reserve was supplied as input rather than read from the network.');
  }

  if (account.subentryCount === 0 && account.numSponsored === 0 && account.numSponsoring === 0) {
    notes.push(
      'No sponsorship metadata was available on the account response; the estimate uses raw subentry count only.',
    );
  }

  return { account, reserve, calculation, notes };
}

export function formatReport(report: SponsorshipReport): string {
  const lines: string[] = [];
  const { account, reserve, calculation } = report;

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  Stellar Sponsorship and Reserve Impact Report');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Account:             ${account.accountId}`);
  lines.push(`  Account sponsored by: ${account.sponsor ?? '(none — self-sponsored)'}`);
  lines.push(`  Subentry count:      ${account.subentryCount}`);
  lines.push(
    `  num_sponsored:       ${account.numSponsored} (entries sponsored by others for this account)`,
  );
  lines.push(`  num_sponsoring:      ${account.numSponsoring} (entries this account sponsors)`);
  lines.push('');

  lines.push('  Sponsored entries identified:');
  if (account.sponsoredEntries.length === 0) {
    lines.push('    (none visible on the account response)');
  }
  for (const entry of account.sponsoredEntries) {
    lines.push(
      `    - ${entry.type}: ${entry.identifier} | sponsor: ${entry.sponsor ?? '(none)'} | ${entry.sponsoredBy}`,
    );
    lines.push(`        ${entry.note}`);
  }
  lines.push(`    Sponsored by another account: ${account.sponsoredByOthers}`);
  lines.push(`    Sponsored by this account:    ${account.sponsoredByThisAccount}`);
  lines.push('');

  lines.push('  Entry types not identifiable through this interface:');
  for (const type of account.unsupportedEntryTypes) lines.push(`    - ${type}`);
  lines.push('');

  lines.push('  Reserve parameters:');
  lines.push(
    `    Base reserve:      ${reserve.baseReserveStroops} stroops (${reserve.baseReserveXlm.toFixed(7)} XLM)`,
  );
  lines.push(
    `    Source:            ${reserve.source === 'horizon-ledger' ? 'latest closed ledger (Horizon)' : 'supplied input'}`,
  );
  lines.push('');

  lines.push('  Reserve calculation:');
  lines.push(`    Formula:           ${calculation.formula}`);
  lines.push(
    `    Effective subentries: ${calculation.effectiveSubentries} (2 + ${calculation.subentryCount} - ${calculation.numSponsored} + ${calculation.numSponsoring})`,
  );
  lines.push(
    `    Minimum reserve:   ${calculation.minimumReserveStroops} stroops (${calculation.minimumReserveXlm.toFixed(7)} XLM)`,
  );
  if (calculation.nativeBalanceXlm !== undefined) {
    lines.push(`    Native balance:    ${calculation.nativeBalanceXlm.toFixed(7)} XLM`);
    lines.push(
      `    Estimated available: ${calculation.estimatedAvailableXlm!.toFixed(7)} XLM (balance minus minimum reserve)`,
    );
  }
  lines.push(`    Confidence:        ESTIMATE — not authoritative`);
  lines.push('');

  lines.push('  Notes:');
  for (const note of report.notes) lines.push(`  - ${note}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: RunParams = {}): Promise<void> {
  const outputJson =
    params.json === true || params.json === 'true' || process.env.OUTPUT_JSON === 'true';
  const horizonUrl = params.horizonUrl || DEFAULT_HORIZON_URL;

  console.log('Starting Sponsorship and Reserve Calculator...');
  console.log(`Using Horizon: ${horizonUrl}`);

  let accountId: string;
  try {
    accountId = validateAccountPublicKey(params.accountId ?? DEFAULT_ACCOUNT_ID);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInput validation failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  const reserveInput = parseBaseReserve(params.baseReserveStroops);

  const server = new Horizon.Server(horizonUrl);

  let account: HorizonAccountLike;
  try {
    account = (await server.loadAccount(accountId)) as unknown as HorizonAccountLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to retrieve account ${accountId} from Horizon: ${message}`);
    console.error('Provide an existing account ID or check network connectivity.');
    process.exitCode = 1;
    return;
  }

  let reserve: ReserveParameters;
  try {
    reserve = await resolveReserveParameters(server, reserveInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to resolve base reserve: ${message}`);
    process.exitCode = 1;
    return;
  }

  const inspection = inspectSponsorship(account);
  const nativeBalance = account.balances.find((b) => b.asset_type === 'native')?.balance;
  const calculation = calculateReserve(inspection, reserve, nativeBalance);

  const report = buildReport(inspection, reserve, calculation);

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  console.log('\nSponsorship and reserve analysis completed. Read-only inspection only.');
}
