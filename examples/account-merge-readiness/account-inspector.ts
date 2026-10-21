/**
 * Account state retrieval for the merge readiness auditor (ISSUE-378).
 *
 * The inspector reads the account state from Horizon. Every collection is
 * retrieved independently so that a failing endpoint degrades the report
 * instead of aborting the whole audit: whatever cannot be retrieved is
 * reported as missing information.
 *
 * The inspector never signs and never submits a transaction.
 */

import { Horizon } from '@stellar/stellar-sdk';
import type {
  AccountSnapshot,
  ClaimableBalanceInfo,
  DataEntryInfo,
  MissingInformation,
  OfferInfo,
  SignerInfo,
  TrustlineInfo,
} from './types';

/** Raw account record as returned by the Horizon accounts endpoint. */
export interface RawAccountRecord {
  account_id: string;
  sequence: string;
  subentry_count: number;
  balances: any[];
  signers: any[];
  data_attr?: Record<string, string>;
  sponsor?: string;
  num_sponsoring?: number;
  num_sponsored?: number;
  thresholds?: { low: number; medium: number; high: number };
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  };
  last_modified_ledger?: number;
}

/** Raw offer record as returned by the Horizon offers endpoint. */
export interface RawOfferRecord {
  id: number | string;
  seller: string;
  selling: any;
  buying: any;
  price?: string;
}

/** Raw claimable balance record. */
export interface RawClaimableBalanceRecord {
  id: string;
  asset: string;
  amount: string;
  claimants?: { address: string; predicate?: { type?: string } }[];
}

/**
 * The data source used by the inspector.
 *
 * The interface exists so that the analysis can be tested with synthetic
 * fixtures and so that an alternative endpoint can be plugged in.
 */
export interface AccountDataSource {
  /** Loads the account record. */
  fetchAccount(accountId: string): Promise<RawAccountRecord>;
  /** Loads the offers of the account. */
  fetchOffers(accountId: string, limit: number): Promise<RawOfferRecord[]>;
  /** Loads the claimable balances the account can claim. */
  fetchClaimableBalances(accountId: string, limit: number): Promise<RawClaimableBalanceRecord[]>;
}

/** Options of the account inspection. */
export interface InspectOptions {
  /** Public key of the account to audit. */
  accountId: string;
  /** Maximum number of records to inspect for every paginated collection. */
  limit?: number;
  /** Data source to read from. Defaults to the Horizon server. */
  source?: AccountDataSource;
}

/** The result of an account inspection. */
export interface InspectionResult {
  /** The normalized account state, when the account could be loaded. */
  snapshot?: AccountSnapshot;
  /** Information that could not be retrieved. */
  missingInformation: MissingInformation[];
  /** The endpoint the audit ran against. */
  endpoint: string;
}

/** Default limit for paginated collections. */
export const DEFAULT_LIMIT = 200;

/** A data source backed by a Horizon server. */
export class HorizonAccountDataSource implements AccountDataSource {
  private readonly server: Horizon.Server;

  constructor(endpoint: string) {
    this.server = new Horizon.Server(endpoint);
  }

  async fetchAccount(accountId: string): Promise<RawAccountRecord> {
    const call = this.server.accounts().accountId(accountId).call();
    return (await call) as unknown as RawAccountRecord;
  }

  async fetchOffers(accountId: string, limit: number): Promise<RawOfferRecord[]> {
    const call = this.server.offers().forAccount(accountId).limit(limit).call();
    const records = (await call) as unknown as { records: RawOfferRecord[] };
    return records.records ?? [];
  }

  async fetchClaimableBalances(
    accountId: string,
    limit: number,
  ): Promise<RawClaimableBalanceRecord[]> {
    const call = this.server.claimableBalances().claimant(accountId).limit(limit).call();
    const records = (await call) as unknown as { records: RawClaimableBalanceRecord[] };
    return records.records ?? [];
  }
}

/** Normalizes a Horizon balance line. */
function normalizeBalance(balance: any): TrustlineInfo {
  const assetType: TrustlineInfo['assetType'] = balance?.asset_type ?? 'native';
  const info: TrustlineInfo = {
    assetType,
    balance: String(balance?.balance ?? '0'),
  };
  if (assetType !== 'native') {
    info.assetCode = balance?.asset_code;
    info.assetIssuer = balance?.asset_issuer;
    info.limit = balance?.limit;
    info.buyingLiabilities = balance?.buying_liabilities;
    info.sellingLiabilities = balance?.selling_liabilities;
    info.isAuthorized = balance?.is_authorized;
    info.isAuthorizedToMaintainLiabilities = balance?.is_authorized_to_maintain_liabilities;
  }
  return info;
}

/** Normalizes a Horizon signer record. */
function normalizeSigner(signer: any): SignerInfo {
  return {
    key: String(signer?.key ?? ''),
    weight: Number(signer?.weight ?? 0),
    type: String(signer?.type ?? 'unknown'),
  };
}

/** Normalizes a Horizon offer record. */
function normalizeOffer(offer: RawOfferRecord): OfferInfo {
  return {
    id: String(offer.id),
    seller: offer.seller,
    selling: {
      assetType: offer.selling?.asset_type ?? 'native',
      assetCode: offer.selling?.asset_code,
      amount: String(offer.selling?.amount ?? '0'),
    },
    buying: {
      assetType: offer.buying?.asset_type ?? 'native',
      assetCode: offer.buying?.asset_code,
      amount: String(offer.buying?.amount ?? '0'),
    },
    price: offer.price,
  };
}

/** Normalizes a Horizon claimable balance record. */
function normalizeClaimableBalance(record: RawClaimableBalanceRecord): ClaimableBalanceInfo {
  return {
    id: record.id,
    asset: record.asset,
    amount: String(record.amount ?? '0'),
    claimants: (record.claimants ?? []).map((claimant) => ({
      address: claimant.address,
      predicate: claimant.predicate?.type,
    })),
  };
}

/**
 * Retrieves and normalizes the account state.
 *
 * The account record itself is required: when it cannot be loaded the audit
 * reports that the merge readiness could not be determined.
 */
export async function inspectAccount(options: InspectOptions): Promise<InspectionResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const source = options.source ?? new HorizonAccountDataSource(DEFAULT_ENDPOINT);
  const missingInformation: MissingInformation[] = [];

  let record: RawAccountRecord;
  try {
    record = await source.fetchAccount(options.accountId);
  } catch (error) {
    missingInformation.push({
      field: 'account',
      reason: error instanceof Error ? error.message : 'The account could not be loaded.',
    });
    return { missingInformation, endpoint: describeEndpoint(source) };
  }

  const native = (record.balances ?? []).find((balance: any) => balance?.asset_type === 'native');
  const trustlines = (record.balances ?? []).map(normalizeBalance);

  const dataEntries: DataEntryInfo[] = Object.keys(record.data_attr ?? {}).map((name) => ({
    name,
  }));

  let offers: OfferInfo[] = [];
  try {
    offers = (await source.fetchOffers(options.accountId, limit)).map(normalizeOffer);
  } catch (error) {
    missingInformation.push({
      field: 'offers',
      reason: error instanceof Error ? error.message : 'The offers could not be loaded.',
    });
  }

  let claimableBalances: ClaimableBalanceInfo[] = [];
  try {
    claimableBalances = (await source.fetchClaimableBalances(options.accountId, limit)).map(
      normalizeClaimableBalance,
    );
  } catch (error) {
    missingInformation.push({
      field: 'claimableBalances',
      reason:
        error instanceof Error ? error.message : 'The claimable balances could not be loaded.',
    });
  }

  const snapshot: AccountSnapshot = {
    accountId: record.account_id ?? options.accountId,
    sequence: String(record.sequence ?? '0'),
    subentryCount: Number(record.subentry_count ?? 0),
    nativeBalance: String(native?.balance ?? '0'),
    trustlines,
    offers,
    signers: (record.signers ?? []).map(normalizeSigner),
    dataEntries,
    claimableBalances,
    sponsor: record.sponsor,
    numSponsoring: Number(record.num_sponsoring ?? 0),
    numSponsored: Number(record.num_sponsored ?? 0),
    thresholds: {
      low: Number(record.thresholds?.low ?? 0),
      medium: Number(record.thresholds?.medium ?? 0),
      high: Number(record.thresholds?.high ?? 0),
    },
    flags: {
      authRequired: Boolean(record.flags?.auth_required),
      authRevocable: Boolean(record.flags?.auth_revocable),
      authImmutable: Boolean(record.flags?.auth_immutable),
      authClawbackEnabled: Boolean(record.flags?.auth_clawback_enabled),
    },
    lastModifiedLedger: record.last_modified_ledger,
  };

  return { snapshot, missingInformation, endpoint: describeEndpoint(source) };
}

/** The default Horizon endpoint used when no endpoint is configured. */
export const DEFAULT_ENDPOINT = 'https://horizon-testnet.stellar.org';

/** Describes the endpoint a data source talks to. */
export function describeEndpoint(source: AccountDataSource): string {
  if (source instanceof HorizonAccountDataSource) {
    return (
      source as unknown as { server: { serverURL: { toString(): string } } }
    ).server.serverURL.toString();
  }
  return 'custom data source';
}
