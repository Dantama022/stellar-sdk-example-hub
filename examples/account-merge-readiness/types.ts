/**
 * Shared types for the account merge readiness auditor (ISSUE-378).
 *
 * The auditor is strictly read-only: it inspects the ledger through Horizon
 * and never signs or submits a transaction.
 */

/** Readiness classification of the audited account. */
export type MergeReadiness =
  | 'no_obvious_blockers'
  | 'potential_blockers'
  | 'additional_review_required'
  | 'unable_to_determine';

/** How strongly a finding is established by the inspected data. */
export type FindingStatus = 'confirmed' | 'potential' | 'needs-review';

/** Severity of a finding. */
export type FindingSeverity = 'blocker' | 'warning' | 'info';

/** A trustline of the audited account. */
export interface TrustlineInfo {
  assetType: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
  limit?: string;
  buyingLiabilities?: string;
  sellingLiabilities?: string;
  isAuthorized?: boolean;
  isAuthorizedToMaintainLiabilities?: boolean;
}

/** An SDEX offer of the audited account. */
export interface OfferInfo {
  id: string;
  seller: string;
  selling: { assetType: string; assetCode?: string; amount: string };
  buying: { assetType: string; assetCode?: string; amount: string };
  price?: string;
}

/** A signer of the audited account. */
export interface SignerInfo {
  key: string;
  weight: number;
  type: string;
}

/** A data entry of the audited account. */
export interface DataEntryInfo {
  name: string;
  valuePreview?: string;
}

/** A claimable balance that the audited account can claim. */
export interface ClaimableBalanceInfo {
  id: string;
  asset: string;
  amount: string;
  claimants: { address: string; predicate?: string }[];
}

/** The normalized account state used by the analysis. */
export interface AccountSnapshot {
  /** Public key of the audited account. */
  accountId: string;
  /** Current sequence number. */
  sequence: string;
  /** Number of subentries reported by the ledger. */
  subentryCount: number;
  /** Native balance in XLM. */
  nativeBalance: string;
  /** Trustlines of the account, including the native balance line. */
  trustlines: TrustlineInfo[];
  /** Offers of the account. */
  offers: OfferInfo[];
  /** Signers of the account. */
  signers: SignerInfo[];
  /** Data entries of the account. */
  dataEntries: DataEntryInfo[];
  /** Claimable balances the account can claim. */
  claimableBalances: ClaimableBalanceInfo[];
  /** Account that sponsors this account, when it is sponsored. */
  sponsor?: string;
  /** Number of entries this account sponsors. */
  numSponsoring: number;
  /** Number of entries this account has sponsored. */
  numSponsored: number;
  /** Operation thresholds of the account. */
  thresholds: { low: number; medium: number; high: number };
  /** Authorization flags of the account. */
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  /** Ledger the account was last modified in. */
  lastModifiedLedger?: number;
}

/** Information that could not be retrieved from the configured endpoint. */
export interface MissingInformation {
  /** Name of the field or collection that is missing. */
  field: string;
  /** Why the information is missing. */
  reason: string;
}

/** A single merge blocker or observation. */
export interface BlockerFinding {
  /** Stable identifier of the finding. */
  id: string;
  /** Short title of the finding. */
  title: string;
  /** Severity of the finding. */
  severity: FindingSeverity;
  /** How the finding is established. */
  status: FindingStatus;
  /** Evidence taken from the inspected ledger data. */
  evidence: string;
  /** The protocol rule the finding is based on. */
  protocolRule: string;
  /** What an operator can do about the finding. */
  remediation?: string;
}

/** The result of the reserve and balance analysis. */
export interface ReserveAnalysis {
  /** The base reserve per ledger entry, in XLM. */
  baseReserve: string;
  /** Number of subentries reported by the ledger. */
  subentryCount: number;
  /** Number of subentries whose reserve is paid by a sponsor. */
  sponsoredEntryCount: number;
  /** Minimum balance the account has to keep, in XLM. */
  minimumBalance: string;
  /** Observed native balance, in XLM. */
  balance: string;
  /** Balance above the minimum balance, in XLM. */
  availableBalance: string;
  /** Base reserve that is released when the account is merged away. */
  releasedBaseReserve: string;
  /** Amount the destination account is expected to receive, in XLM. */
  projectedDestinationIncrease: string;
  /** Estimated transaction fee, in XLM. */
  estimatedFee: string;
  /** Assumptions the numbers are based on. */
  assumptions: string[];
}

/** The complete audit report. */
export interface MergeAuditReport {
  /** Public key of the audited account. */
  accountId: string;
  /** Name of the network the audit ran against. */
  network: string;
  /** Horizon endpoint that was queried. */
  endpoint: string;
  /** ISO timestamp of the audit. */
  auditedAt: string;
  /** The inspected account state. */
  account: AccountSnapshot;
  /** All findings, ordered by severity. */
  findings: BlockerFinding[];
  /** Reserve and balance analysis. */
  reserve: ReserveAnalysis;
  /** Readiness classification. */
  readiness: MergeReadiness;
  /** Evidence that supports the classification. */
  readinessEvidence: string[];
  /** Information that could not be retrieved. */
  missingInformation: MissingInformation[];
  /** Limitations of a static audit. */
  limitations: string[];
}
