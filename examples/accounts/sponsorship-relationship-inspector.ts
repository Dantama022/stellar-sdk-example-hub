/**
 * ISSUE-405: Stellar account sponsorship relationship and reserve dependency inspector.
 *
 * Reads account-level sponsorship fields and any entry-level sponsorship data
 * exposed by the endpoint, distinguishes "sponsoring" from "sponsored",
 * estimates reserve obligations with stroop arithmetic, and reports unresolved
 * dependencies and data-source limitations. It never submits an operation.
 *
 * Usage:
 *   npx ts-node examples/accounts/sponsorship-relationship-inspector.ts \
 *     --account G... --base-reserve 0.5 [--json]
 */

import { Horizon } from '@stellar/stellar-sdk';

const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const STROOPS_PER_XLM = 10_000_000n;
const DEFAULT_SUPPORTED_TYPES = ['account', 'trustlines', 'signers', 'data'];

export type EntryType = 'account' | 'trustline' | 'signer' | 'data' | 'offer' | 'other';

export interface SponsorshipMetadata {
  accountId: string;
  accountSponsor: string | null;
  numSponsoring: number | null;
  numSponsored: number | null;
  sponsorshipCounter: number | null;
  subentryCount: number | null;
  sequence: string | null;
}

export interface EntrySponsorship {
  type: EntryType;
  owner: string;
  label: string;
  sponsor: string | null;
}

export interface SponsorshipData {
  metadata: SponsorshipMetadata;
  entries: EntrySponsorship[];
  limitations: string[];
}

export interface ReserveEstimate {
  baseReserveStroops: string;
  outgoingReserveStroops: string;
  incomingReserveReliefStroops: string;
  ownReserveStroops: string;
  sponsoredEntryCount: number;
  ownSubentryCount: number;
  assumptions: string[];
}

export interface SponsorshipReport {
  inspectedAccount: string;
  network: string;
  sponsors: string[];
  sponsored: string[];
  entries: EntrySponsorship[];
  metadata: SponsorshipMetadata;
  reserve: ReserveEstimate | null;
  risks: string[];
  warnings: string[];
  limitations: string[];
  errors: string[];
}

export interface InspectOptions {
  baseReserveStroops?: bigint;
  significantReserveStroops?: bigint;
  supportedEntryTypes?: string[];
  network?: string;
}

export interface AccountLoader {
  loadAccount(accountId: string): Promise<unknown>;
}

type AccountRecord = Record<string, unknown>;

function asRecord(value: unknown): AccountRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AccountRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPublicKey(value: string): boolean {
  return PUBLIC_KEY_RE.test(value);
}

/** Converts a decimal XLM base reserve to exact stroops. */
export function parseBaseReserve(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid base reserve: ${value}`);
  return BigInt(match[1]) * STROOPS_PER_XLM + BigInt((match[2] ?? '').padEnd(7, '0') || '0');
}

export function formatStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

/** Extracts account-level sponsorship metadata. */
export function extractSponsorshipMetadata(record: unknown): SponsorshipMetadata {
  const source = asRecord(record);
  if (!source) throw new Error('Account record must be an object');
  return {
    accountId: asString(source.account_id) ?? '<unknown>',
    accountSponsor: asString(source.sponsor),
    numSponsoring: asNumber(source.num_sponsoring),
    numSponsored: asNumber(source.num_sponsored),
    sponsorshipCounter: asNumber(source.sponsorship_counter),
    subentryCount: asNumber(source.subentry_count),
    sequence: asString(source.sequence),
  };
}

/** Extracts entry-level sponsorship information where the endpoint exposes it. */
export function extractSponsorshipData(
  record: unknown,
  options: Pick<InspectOptions, 'supportedEntryTypes'> = {},
): SponsorshipData {
  const source = asRecord(record);
  if (!source) throw new Error('Account record must be an object');
  const metadata = extractSponsorshipMetadata(source);
  const supported = options.supportedEntryTypes ?? DEFAULT_SUPPORTED_TYPES;
  const entries: EntrySponsorship[] = [];
  const limitations: string[] = [];

  if (metadata.accountSponsor) {
    entries.push({
      type: 'account',
      owner: metadata.accountId,
      label: 'account entry',
      sponsor: metadata.accountSponsor,
    });
  }

  if (supported.includes('trustlines')) {
    const balances = Array.isArray(source.balances) ? source.balances : [];
    for (const raw of balances) {
      const balance = asRecord(raw);
      if (!balance || balance.asset_type === 'native') continue;
      const code = asString(balance.asset_code) ?? '<unknown>';
      const issuer = asString(balance.asset_issuer) ?? '<unknown>';
      entries.push({
        type: 'trustline',
        owner: metadata.accountId,
        label: `trustline ${code}:${issuer}`,
        sponsor: asString(balance.sponsor),
      });
    }
  } else {
    limitations.push('Trustline sponsorship was not requested (supportedEntryTypes).');
  }

  if (supported.includes('signers')) {
    if (Array.isArray(source.signers)) {
      for (const raw of source.signers) {
        const signer = asRecord(raw);
        if (!signer) continue;
        entries.push({
          type: 'signer',
          owner: metadata.accountId,
          label: `signer ${asString(signer.key) ?? asString(signer.public_key) ?? '<unknown>'}`,
          sponsor: asString(signer.sponsor),
        });
      }
    } else {
      limitations.push('Signer sponsorship data is not exposed by this endpoint response.');
    }
  }

  if (supported.includes('data')) {
    const data = asRecord(source.data);
    if (data) {
      for (const key of Object.keys(data)) {
        entries.push({
          type: 'data',
          owner: metadata.accountId,
          label: `data entry ${key}`,
          sponsor: asString(asRecord(data[key])?.sponsor),
        });
      }
    } else {
      limitations.push('Data-entry sponsorship data is not exposed by this endpoint response.');
    }
  }

  if (supported.includes('offers')) {
    limitations.push(
      'Offer sponsorship is not exposed by the account endpoint; a dedicated offers endpoint would be required.',
    );
  }

  return { metadata, entries, limitations };
}

/** Estimates reserve responsibility from the available sponsorship metadata. */
export function estimateReserveDependencies(
  metadata: SponsorshipMetadata,
  entries: EntrySponsorship[],
  baseReserveStroops: bigint,
): ReserveEstimate {
  const sponsoredEntryCount = entries.filter(
    (entry) => entry.sponsor !== null && entry.sponsor !== metadata.accountId,
  ).length;
  const subentryCount = metadata.subentryCount ?? sponsoredEntryCount;
  const ownSubentryCount = Math.max(0, subentryCount - sponsoredEntryCount);
  const outgoing = BigInt(Math.max(0, metadata.numSponsoring ?? 0));
  const incoming = BigInt(sponsoredEntryCount);
  const own = BigInt(ownSubentryCount);

  return {
    baseReserveStroops: baseReserveStroops.toString(),
    outgoingReserveStroops: (outgoing * baseReserveStroops).toString(),
    incomingReserveReliefStroops: (incoming * baseReserveStroops).toString(),
    ownReserveStroops: (own * baseReserveStroops).toString(),
    sponsoredEntryCount,
    ownSubentryCount,
    assumptions: [
      'One base reserve is assumed per sponsored subentry.',
      "outgoingReserveStroops is this account's responsibility for entries it sponsors.",
      'incomingReserveReliefStroops is the responsibility shifted to other sponsors.',
      metadata.subentryCount === null
        ? 'subentry_count was unavailable, so own-reserve uses only the resolved sponsored entries.'
        : "subentry_count from the endpoint is used to estimate the account's own subentries.",
      'Estimates exclude trustline limits, liabilities, and any protocol-specific reserve rules.',
    ],
  };
}

export async function loadAccount(loader: AccountLoader, accountId: string): Promise<unknown> {
  if (!isPublicKey(accountId)) throw new Error(`Invalid account public key: ${accountId}`);
  try {
    return await loader.loadAccount(accountId);
  } catch (error) {
    throw new Error(`Unable to load account ${accountId}: ${errorMessage(error)}`);
  }
}

/** Builds a relationship report without submitting any sponsorship operation. */
export async function inspectSponsorship(
  loader: AccountLoader,
  accountId: string,
  options: InspectOptions = {},
): Promise<SponsorshipReport> {
  const errors: string[] = [];
  const data: SponsorshipData = extractSponsorshipData(
    await loadAccount(loader, accountId),
    options,
  );

  const sponsorSet = new Set<string>();
  const sponsoredSet = new Set<string>();
  if (data.metadata.accountSponsor) {
    sponsorSet.add(data.metadata.accountSponsor);
    sponsoredSet.add(data.metadata.accountId);
  }
  for (const entry of data.entries) {
    if (entry.sponsor) {
      sponsorSet.add(entry.sponsor);
      sponsoredSet.add(entry.owner);
    }
  }

  const unresolvedSponsorIds = [...sponsorSet];
  for (const sponsorId of unresolvedSponsorIds) {
    try {
      await loadAccount(loader, sponsorId);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const baseReserve = options.baseReserveStroops ?? 0n;
  const reserve =
    options.baseReserveStroops === undefined
      ? null
      : estimateReserveDependencies(data.metadata, data.entries, baseReserve);
  const significant = options.significantReserveStroops ?? 5n * STROOPS_PER_XLM;

  const risks: string[] = [];
  const warnings: string[] = [];
  if (sponsorSet.size > 1) {
    risks.push(`Account has ${sponsorSet.size} distinct sponsorship dependencies.`);
  }
  if ((data.metadata.numSponsored ?? 0) > 0 && sponsoredSet.size === 0) {
    risks.push(
      'num_sponsored is positive but no sponsored entry could be resolved from the available data.',
    );
  }
  if ((data.metadata.numSponsoring ?? 0) > 0 && data.entries.length === 0) {
    warnings.push(
      'num_sponsoring is positive but no sponsored entries are visible from this endpoint.',
    );
  }
  if (data.metadata.numSponsoring === null || data.metadata.numSponsored === null) {
    warnings.push(
      'Account-level sponsorship counters are unavailable; relationships may be incomplete.',
    );
  }
  for (const entry of data.entries) {
    if (entry.sponsor === null) {
      warnings.push(`Sponsorship information is unavailable for ${entry.label}.`);
    }
  }
  if (reserve && BigInt(reserve.outgoingReserveStroops) >= significant) {
    risks.push(
      `Outgoing sponsored reserve ${formatStroops(BigInt(reserve.outgoingReserveStroops))} XLM exceeds the configured significance threshold.`,
    );
  }
  for (const error of errors) {
    risks.push(`Sponsor account could not be verified: ${error}`);
  }

  return {
    inspectedAccount: accountId,
    network: options.network ?? '<unspecified>',
    sponsors: [...sponsorSet].sort(),
    sponsored: [...sponsoredSet].sort(),
    entries: data.entries,
    metadata: data.metadata,
    reserve,
    risks,
    warnings,
    limitations: [
      ...data.limitations,
      'Account-level sponsorship fields describe the current state, not the full historical sponsorship chain.',
      'Entry-level sponsorship is only reported for endpoint fields that are actually present.',
    ],
    errors,
  };
}

export function formatReport(report: SponsorshipReport): string {
  const lines = [
    'Sponsorship relationship report (no operation submitted)',
    `Account:        ${report.inspectedAccount}`,
    `Network:        ${report.network}`,
    `Account sponsor: ${report.metadata.accountSponsor ?? '<none>'}`,
    `Sponsoring:     ${report.metadata.numSponsoring ?? '<unavailable>'} entries`,
    `Sponsored by:   ${report.metadata.numSponsored ?? '<unavailable>'} entries`,
    `Sponsors:       ${report.sponsors.length ? report.sponsors.join(', ') : '<none resolved>'}`,
    `Sponsored:      ${report.sponsored.length ? report.sponsored.join(', ') : '<none resolved>'}`,
  ];
  for (const entry of report.entries) {
    lines.push(`ENTRY  ${entry.type} ${entry.label} -> ${entry.sponsor ?? '<unresolved>'}`);
  }
  if (report.reserve) {
    lines.push(
      `RESERVE base=${formatStroops(BigInt(report.reserve.baseReserveStroops))} XLM`,
      `RESERVE outgoing=${formatStroops(BigInt(report.reserve.outgoingReserveStroops))} XLM`,
      `RESERVE incoming relief=${formatStroops(BigInt(report.reserve.incomingReserveReliefStroops))} XLM`,
      `RESERVE own=${formatStroops(BigInt(report.reserve.ownReserveStroops))} XLM`,
    );
  } else {
    lines.push('RESERVE unavailable: no base reserve was supplied.');
  }
  for (const risk of report.risks) lines.push(`RISK   ${risk}`);
  for (const warning of report.warnings) lines.push(`WARN   ${warning}`);
  for (const limitation of report.limitations) lines.push(`LIMIT  ${limitation}`);
  for (const error of report.errors) lines.push(`ERROR  ${error}`);
  return lines.join('\n');
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function run(params?: any): Promise<void> {
  const args = (params?.args as string[] | undefined) ?? process.argv.slice(2);
  const account = params?.account ?? argumentValue(args, '--account');
  if (!account) {
    console.log(
      'Usage: sponsorship-relationship-inspector --account G... [--base-reserve <XLM>] [--json]',
    );
    return;
  }

  const horizonUrl =
    params?.horizonUrl ?? argumentValue(args, '--horizon') ?? 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);
  const loader: AccountLoader = {
    loadAccount: async (accountId) =>
      (await server.loadAccount(accountId)) as unknown as AccountRecord,
  };

  let baseReserveStroops: bigint | undefined;
  try {
    const rawBaseReserve = params?.baseReserve ?? argumentValue(args, '--base-reserve');
    if (rawBaseReserve !== undefined) baseReserveStroops = parseBaseReserve(String(rawBaseReserve));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  const report = await inspectSponsorship(loader, account, {
    baseReserveStroops,
    network: params?.network ?? argumentValue(args, '--network'),
  });
  if (params?.json ?? args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}
