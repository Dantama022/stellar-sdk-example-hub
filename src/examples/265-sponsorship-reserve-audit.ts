import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const DEFAULT_BASE_RESERVE_XLM = 0.5;

export interface SponsorshipBalanceInput {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  sponsor?: string;
}

export interface SponsorshipSignerInput {
  key: string;
  type: string;
  weight: number;
  sponsor?: string;
}

export interface SponsorshipAccountRecord {
  account_id: string;
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  sponsor?: string;
  balances?: SponsorshipBalanceInput[];
  signers?: SponsorshipSignerInput[];
}

export interface SponsoredLedgerEntry {
  entryType: 'trustline' | 'signer' | 'offer' | 'data' | 'claimable_balance' | 'account';
  id: string;
  sponsor: string;
}

export interface SponsoredEntriesPage {
  records: SponsoredLedgerEntry[];
  next?: () => Promise<SponsoredEntriesPage>;
}

export interface SponsorshipDataSource {
  loadAccount(accountId: string): Promise<SponsorshipAccountRecord>;
  loadSponsoredEntriesPages?(accountId: string): Promise<SponsoredEntriesPage>;
}

export interface RetrievedSponsorshipData {
  accountId: string;
  horizonUrl: string;
  account: SponsorshipAccountRecord;
  additionalSponsoredEntries: SponsoredLedgerEntry[];
  additionalEntriesComplete: boolean;
  pagesFetched: number;
  retrievalWarnings: string[];
}

export interface SponsorshipRelationshipAnalysis {
  accountId: string;
  accountSponsor: string | null;
  numSponsoring: number | null;
  numSponsored: number | null;
  sponsoredSigners: Array<{ key: string; type: string; weight: number; sponsor: string }>;
  sponsoredTrustlines: Array<{ assetIdentity: string; sponsor: string }>;
  additionalSponsoredEntriesCount: number;
  confirmedFindings: string[];
  potentialInconsistencies: string[];
  unresolvedChecks: string[];
  missingData: string[];
}

export interface ReserveAssessment {
  status: 'estimated' | 'insufficient_data';
  currentNativeBalanceXlm: string | null;
  subentryCount: number | null;
  numSponsoring: number | null;
  numSponsored: number | null;
  baseReserveXlm: number | null;
  effectiveReserveEntries: number | null;
  minimumReserveEstimateXlm: string | null;
  estimatedAboveReserveXlm: string | null;
  assumptions: string[];
  missingInputs: string[];
}

export interface SponsorshipAuditReport {
  accountId: string;
  horizonUrl: string;
  relationships: SponsorshipRelationshipAnalysis;
  reserveAssessment: ReserveAssessment;
  disclaimer: string;
}

export interface SponsorshipAuditParams {
  accountId?: string;
  horizonUrl?: string;
  baseReserveXlm?: number | string;
  json?: boolean | string;
}

export function createHorizonSponsorshipDataSource(horizonUrl: string): SponsorshipDataSource {
  const server = new Horizon.Server(horizonUrl);
  return {
    async loadAccount(accountId: string): Promise<SponsorshipAccountRecord> {
      const account = await server.loadAccount(accountId);
      return account as unknown as SponsorshipAccountRecord;
    },
  };
}

export async function fetchSponsorshipAccountData(
  accountId: string,
  horizonUrl: string,
  dataSource: SponsorshipDataSource,
): Promise<RetrievedSponsorshipData> {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error(`Invalid Stellar account public key: "${accountId}"`);
  }

  const account = await dataSource.loadAccount(accountId);
  if (!account || typeof account !== 'object' || typeof account.account_id !== 'string') {
    throw new Error(`Unexpected Horizon account response structure for ${accountId}.`);
  }

  const additionalSponsoredEntries: SponsoredLedgerEntry[] = [];
  let additionalEntriesComplete = false;
  let pagesFetched = 0;
  const retrievalWarnings: string[] = [];

  if (dataSource.loadSponsoredEntriesPages) {
    let page = await dataSource.loadSponsoredEntriesPages(accountId);
    pagesFetched += 1;
    if (Array.isArray(page.records)) {
      additionalSponsoredEntries.push(...page.records);
    }

    while (typeof page.next === 'function') {
      try {
        page = await page.next();
        pagesFetched += 1;
        if (!Array.isArray(page.records)) {
          retrievalWarnings.push(`Page ${pagesFetched} returned a non-array sponsored entries payload.`);
          break;
        }
        if (page.records.length === 0) break;
        additionalSponsoredEntries.push(...page.records);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Pagination failed while loading sponsored entries after ${pagesFetched} page(s): ${message}`,
        );
      }
    }
    additionalEntriesComplete = retrievalWarnings.length === 0;
  } else {
    retrievalWarnings.push(
      'Only the Horizon account record was retrieved; separate offers, data entries, and claimable balances were not queried.',
    );
  }

  return {
    accountId,
    horizonUrl,
    account,
    additionalSponsoredEntries,
    additionalEntriesComplete,
    pagesFetched,
    retrievalWarnings,
  };
}

export function analyzeSponsorshipRelationships(
  retrieved: RetrievedSponsorshipData,
): SponsorshipRelationshipAnalysis {
  const { account } = retrieved;
  const confirmedFindings: string[] = [];
  const potentialInconsistencies: string[] = [];
  const unresolvedChecks: string[] = [];
  const missingData: string[] = [...retrieved.retrievalWarnings];

  const accountSponsor = typeof account.sponsor === 'string' && account.sponsor.trim() !== ''
    ? account.sponsor.trim()
    : null;
  const numSponsoring = typeof account.num_sponsoring === 'number' ? account.num_sponsoring : null;
  const numSponsored = typeof account.num_sponsored === 'number' ? account.num_sponsored : null;

  if (numSponsoring === null) {
    missingData.push('num_sponsoring is missing from the account response.');
  }
  if (numSponsored === null) {
    missingData.push('num_sponsored is missing from the account response.');
  }

  const sponsoredSigners: SponsorshipRelationshipAnalysis['sponsoredSigners'] = [];
  if (Array.isArray(account.signers)) {
    for (const signer of account.signers) {
      if (typeof signer.sponsor === 'string' && signer.sponsor.trim() !== '') {
        sponsoredSigners.push({
          key: signer.key,
          type: signer.type,
          weight: signer.weight,
          sponsor: signer.sponsor.trim(),
        });
      }
    }
  } else {
    missingData.push('Account signers array was not present in the response.');
  }

  const sponsoredTrustlines: SponsorshipRelationshipAnalysis['sponsoredTrustlines'] = [];
  if (Array.isArray(account.balances)) {
    for (const bal of account.balances) {
      if (bal.asset_type !== 'native' && typeof bal.sponsor === 'string' && bal.sponsor.trim() !== '') {
        const assetIdentity = `${bal.asset_code ?? 'UNKNOWN'}:${bal.asset_issuer ?? 'UNKNOWN'}`;
        sponsoredTrustlines.push({
          assetIdentity,
          sponsor: bal.sponsor.trim(),
        });
      }
    }
  } else {
    missingData.push('Account balances array was not present in the response.');
  }

  if (numSponsoring !== null && numSponsoring > 0) {
    confirmedFindings.push(
      `Account is sponsoring ${numSponsoring} ledger entry/entries for itself or other accounts (increases this account's reserve responsibility).`,
    );
    unresolvedChecks.push(
      'Horizon account records report num_sponsoring count, but do not enumerate every external account entry sponsored by this account.',
    );
  }

  if (numSponsored !== null && numSponsored > 0) {
    confirmedFindings.push(
      `Account has ${numSponsored} sponsored ledger entry/entries whose base reserve is covered by a sponsoring account.`,
    );
  }

  if (accountSponsor) {
    confirmedFindings.push(`Account base reserve itself is sponsored by ${accountSponsor}.`);
  }

  if (numSponsoring === 0 && numSponsored === 0 && !accountSponsor) {
    confirmedFindings.push('Account has no active sponsorship relationships recorded.');
  }

  if (accountSponsor && numSponsored === 0) {
    potentialInconsistencies.push(
      `Account lists sponsor=${accountSponsor} while num_sponsored=0.`,
    );
  }

  const observedSponsoredForAccount =
    (accountSponsor ? 1 : 0) +
    sponsoredSigners.length +
    sponsoredTrustlines.length +
    retrieved.additionalSponsoredEntries.length;

  if (numSponsored !== null && numSponsored > observedSponsoredForAccount) {
    if (retrieved.additionalEntriesComplete) {
      potentialInconsistencies.push(
        `Account reports num_sponsored=${numSponsored}, but complete ledger-entry inspection only observed ${observedSponsoredForAccount} sponsored entry/entries.`,
      );
    } else {
      unresolvedChecks.push(
        `Account reports num_sponsored=${numSponsored}, while ${observedSponsoredForAccount} sponsored entry/entries were visible on the account record; remaining entries may be offers, data entries, or claimable balances not retrieved here.`,
      );
    }
  }

  return {
    accountId: retrieved.accountId,
    accountSponsor,
    numSponsoring,
    numSponsored,
    sponsoredSigners,
    sponsoredTrustlines,
    additionalSponsoredEntriesCount: retrieved.additionalSponsoredEntries.length,
    confirmedFindings,
    potentialInconsistencies,
    unresolvedChecks,
    missingData,
  };
}

export function estimateAccountReserves(
  account: SponsorshipAccountRecord,
  baseReserveXlm: number | null = DEFAULT_BASE_RESERVE_XLM,
): ReserveAssessment {
  const missingInputs: string[] = [];

  const nativeEntry = Array.isArray(account.balances)
    ? account.balances.find((b) => b.asset_type === 'native')
    : undefined;
  const currentNativeBalanceXlm =
    nativeEntry && /^\d+(\.\d+)?$/.test(nativeEntry.balance) ? nativeEntry.balance : null;
  if (currentNativeBalanceXlm === null) {
    missingInputs.push('Native XLM balance is missing or invalid.');
  }

  const subentryCount = typeof account.subentry_count === 'number' ? account.subentry_count : null;
  if (subentryCount === null) missingInputs.push('subentry_count is unavailable.');

  const numSponsoring = typeof account.num_sponsoring === 'number' ? account.num_sponsoring : null;
  if (numSponsoring === null) missingInputs.push('num_sponsoring is unavailable.');

  const numSponsored = typeof account.num_sponsored === 'number' ? account.num_sponsored : null;
  if (numSponsored === null) missingInputs.push('num_sponsored is unavailable.');

  if (baseReserveXlm === null || !Number.isFinite(baseReserveXlm) || baseReserveXlm <= 0) {
    missingInputs.push('Valid network baseReserveXlm parameter is unavailable.');
  }

  if (missingInputs.length > 0) {
    return {
      status: 'insufficient_data',
      currentNativeBalanceXlm,
      subentryCount,
      numSponsoring,
      numSponsored,
      baseReserveXlm: baseReserveXlm ?? null,
      effectiveReserveEntries: null,
      minimumReserveEstimateXlm: null,
      estimatedAboveReserveXlm: null,
      assumptions: [
        'Reserve calculation skipped because one or more required inputs are missing.',
      ],
      missingInputs,
    };
  }

  const effectiveEntries = 2 + subentryCount! + numSponsoring! - numSponsored!;
  const minimumReserve = effectiveEntries * baseReserveXlm!;
  const balanceNum = Number(currentNativeBalanceXlm!);
  const aboveReserve = balanceNum - minimumReserve;

  return {
    status: 'estimated',
    currentNativeBalanceXlm,
    subentryCount,
    numSponsoring,
    numSponsored,
    baseReserveXlm,
    effectiveReserveEntries: effectiveEntries,
    minimumReserveEstimateXlm: minimumReserve.toFixed(7),
    estimatedAboveReserveXlm: aboveReserve.toFixed(7),
    assumptions: [
      `Used base reserve of ${baseReserveXlm} XLM per entry (2 base entries + subentry_count + num_sponsoring - num_sponsored).`,
      'Selling liabilities and pending transaction fees are not deducted from the estimated amount above reserve.',
      'Network protocol upgrades or fee changes can alter base reserve requirements.',
    ],
    missingInputs: [],
  };
}

export function formatSponsorshipAuditReport(report: SponsorshipAuditReport): string {
  const { relationships: rel, reserveAssessment: res } = report;
  const lines: string[] = [
    '=== Stellar Account Sponsorship & Reserve Audit Report ===',
    `Account: ${report.accountId}`,
    `Horizon: ${report.horizonUrl}`,
    `Account sponsor: ${rel.accountSponsor ?? 'none'}`,
    `num_sponsoring: ${rel.numSponsoring ?? 'unavailable'}`,
    `num_sponsored: ${rel.numSponsored ?? 'unavailable'}`,
    `Sponsored signers: ${rel.sponsoredSigners.length}`,
    `Sponsored trustlines: ${rel.sponsoredTrustlines.length}`,
    '',
    'Reserve Assessment:',
    `  Status: ${res.status}`,
    `  Current XLM balance: ${res.currentNativeBalanceXlm ?? 'unavailable'}`,
    `  Effective reserve entries: ${res.effectiveReserveEntries ?? 'unavailable'}`,
    `  Minimum reserve estimate (XLM): ${res.minimumReserveEstimateXlm ?? 'unavailable'}`,
    `  Estimated above reserve (XLM): ${res.estimatedAboveReserveXlm ?? 'unavailable'}`,
  ];

  if (rel.confirmedFindings.length > 0) {
    lines.push('', 'Confirmed Findings:');
    for (const f of rel.confirmedFindings) lines.push(`  - ${f}`);
  }

  if (rel.potentialInconsistencies.length > 0) {
    lines.push('', 'Potential Inconsistencies:');
    for (const i of rel.potentialInconsistencies) lines.push(`  - ${i}`);
  }

  if (rel.unresolvedChecks.length > 0) {
    lines.push('', 'Unresolved Checks:');
    for (const u of rel.unresolvedChecks) lines.push(`  - ${u}`);
  }

  if (rel.missingData.length > 0 || res.missingInputs.length > 0) {
    lines.push('', 'Missing Data:');
    for (const m of [...rel.missingData, ...res.missingInputs]) lines.push(`  - ${m}`);
  }

  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function runSponsorshipReserveAudit(
  accountId: string,
  horizonUrl: string,
  baseReserveXlm: number | null = DEFAULT_BASE_RESERVE_XLM,
  dataSource: SponsorshipDataSource = createHorizonSponsorshipDataSource(horizonUrl),
): Promise<SponsorshipAuditReport> {
  const retrieved = await fetchSponsorshipAccountData(accountId, horizonUrl, dataSource);
  const relationships = analyzeSponsorshipRelationships(retrieved);
  const reserveAssessment = estimateAccountReserves(retrieved.account, baseReserveXlm);

  return {
    accountId,
    horizonUrl,
    relationships,
    reserveAssessment,
    disclaimer:
      'Read-only audit only. This report does not modify sponsorship relationships or guarantee transaction affordability.',
  };
}

export async function run(params: SponsorshipAuditParams = {}): Promise<void> {
  const accountId = params.accountId?.trim() || process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const horizonUrl = params.horizonUrl?.trim() || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const baseReserveXlm =
    params.baseReserveXlm !== undefined ? Number(params.baseReserveXlm) : DEFAULT_BASE_RESERVE_XLM;
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  try {
    const report = await runSponsorshipReserveAudit(accountId, horizonUrl, baseReserveXlm);
    console.log(json ? JSON.stringify(report, null, 2) : formatSponsorshipAuditReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ accountId, horizonUrl, error: message }, null, 2));
    } else {
      console.error(`Could not audit sponsorship for ${accountId}: ${message}`);
    }
  }
}
