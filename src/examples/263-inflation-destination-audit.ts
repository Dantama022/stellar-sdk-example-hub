import { Horizon, Networks, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * ISSUE-419: Stellar Account Inflation Destination and Network Configuration Auditor
 *
 * Stellar accounts can still carry the legacy `inflation destination` field, but
 * the inflation mechanism itself was disabled at the protocol level. This
 * example audits that field and the surrounding network configuration without
 * implying that inflation works, that setting a destination enables payments, or
 * that the network currently distributes inflation rewards.
 *
 * The implementation keeps four stages separate:
 *
 *   1. Retrieval - Horizon account, network passphrase, and operation history.
 *   2. Inspection - legacy field presence, StrKey validation, network checks.
 *   3. History    - historical `set_options` operations that changed the field.
 *   4. Reporting  - human-readable and JSON audit reports.
 */

export const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export const DEFAULT_HISTORY_LIMIT = 20;

export const MAX_HISTORY_LIMIT = 200;

/**
 * Shown in every report. The wording is intentionally explicit: the field is
 * legacy configuration, never an active reward entitlement.
 */
export const LEGACY_INFLATION_NOTICE =
  'The Stellar inflation mechanism has been disabled since protocol 12. An inflation ' +
  'destination is a historical account field only: configuring or retaining one does not ' +
  'enable inflation payments, and the network does not currently distribute inflation ' +
  'rewards. Do not configure inflation destinations for new applications.';

/** Networks this SDK can name from a passphrase. */
const KNOWN_NETWORKS: Array<{ name: string; passphrase: string }> = [
  { name: 'mainnet', passphrase: Networks.PUBLIC },
  { name: 'testnet', passphrase: Networks.TESTNET },
  { name: 'futurenet', passphrase: Networks.FUTURENET },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuditStatus = 'ok' | 'warning' | 'error' | 'not-found';

export type DestinationFormat = 'none' | 'ed25519-account' | 'muxed-account' | 'invalid';

export type HistoryStatus = 'retrieved' | 'empty' | 'unavailable' | 'not-requested';

export type HistoryScope = 'transaction' | 'account' | 'none';

export interface AuditWarning {
  field: string;
  message: string;
}

export interface DestinationValidation {
  provided: boolean;
  value: string | null;
  valid: boolean | null;
  format: DestinationFormat;
  reason: string | null;
}

export interface InflationDestinationInspection {
  /** Whether the account record exposed an inflation destination field at all. */
  fieldReturned: boolean;
  destination: string | null;
  validation: DestinationValidation;
  configured: boolean;
  operational: false;
  explanation: string;
}

export interface ParsedAccountRecord {
  accountId: string | null;
  sequence: string | null;
  inflationDestination: string | null;
  inflationDestinationFieldPresent: boolean;
  homeDomain: string | null;
  subentryCount: number | null;
  lastModifiedLedger: number | null;
  malformed: boolean;
  warnings: AuditWarning[];
}

export interface NetworkConfigurationCheck {
  configuredPassphrase: string;
  configuredNetwork: string | null;
  endpointPassphrase: string | null;
  endpointNetwork: string | null;
  checked: boolean;
  mismatch: boolean;
  warnings: string[];
}

export interface HistoricalConfigurationChange {
  operationType: string;
  createdAt: string | null;
  ledger: number | null;
  transactionHash: string | null;
  sourceAccount: string | null;
  inflationDestination: string;
  destinationValid: boolean;
  summary: string;
}

export interface HistoryAudit {
  status: HistoryStatus;
  scope: HistoryScope;
  examinedOperations: number;
  changes: HistoricalConfigurationChange[];
  warnings: string[];
}

export interface AccountAuditReport {
  accountId: string;
  horizonUrl: string;
  network: string | null;
  networkPassphrase: string;
  account: {
    exists: boolean;
    sequence: string | null;
    homeDomain: string | null;
    subentryCount: number | null;
    lastModifiedLedger: number | null;
  };
  inflationDestination: InflationDestinationInspection;
  networkCheck: NetworkConfigurationCheck;
  history: HistoryAudit;
  legacyNotice: string;
  status: AuditStatus;
  warnings: AuditWarning[];
  unavailable: string[];
}

export interface AuditOptions {
  accountId: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  /** Fetch recent account history. */
  includeHistory?: boolean | string;
  /** Inspect the operations of one transaction instead of account history. */
  transactionHash?: string;
  /** Maximum number of operations to examine (1-200). */
  historyLimit?: number | string;
}

export interface AuditParams {
  accountId?: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  includeHistory?: boolean | string;
  transactionHash?: string;
  historyLimit?: number | string;
  json?: boolean | string;
}

export interface AccountAuditDeps {
  horizonUrl: string;
  fetchAccount(accountId: string): Promise<unknown>;
  fetchNetworkPassphrase(): Promise<string | null>;
  fetchAccountOperations?(accountId: string, limit: number): Promise<unknown[]>;
  fetchTransactionOperations?(transactionHash: string, limit: number): Promise<unknown[]>;
}

/** Raised by the Horizon provider when the account does not exist. */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Stage 1: retrieval
// ---------------------------------------------------------------------------

export function isValidAccountId(value: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(value.trim());
  } catch {
    return false;
  }
}

/**
 * Horizon provider. Only the fields used by the audit are copied out, so account
 * data stays separate from endpoint configuration.
 */
export function createHorizonAuditDeps(horizonUrl: string): AccountAuditDeps {
  const endpoint = horizonUrl.trim();
  const server = new Horizon.Server(endpoint);

  return {
    horizonUrl: endpoint,
    async fetchAccount(accountId: string): Promise<unknown> {
      try {
        const account = (await server.loadAccount(accountId)) as unknown as Record<string, unknown>;

        return {
          account_id: account.account_id ?? account.accountId ?? null,
          sequence: account.sequence ?? account.sequenceNumber ?? null,
          inflation_destination: account.inflation_destination ?? null,
          inflation_dest: account.inflation_dest ?? null,
          home_domain: account.home_domain ?? null,
          subentry_count: account.subentry_count ?? null,
          last_modified_ledger: account.last_modified_ledger ?? null,
        };
      } catch (error: unknown) {
        if (isHttpNotFound(error)) {
          throw new AccountNotFoundError(
            `Horizon has no account record for ${accountId} at ${endpoint}.`,
          );
        }

        throw new Error(`Horizon account request failed: ${getErrorMessage(error)}`);
      }
    },
    async fetchNetworkPassphrase(): Promise<string | null> {
      const root = await server.root();

      return typeof root.network_passphrase === 'string' && root.network_passphrase.length > 0
        ? root.network_passphrase
        : null;
    },
    async fetchAccountOperations(accountId: string, limit: number): Promise<unknown[]> {
      const page = await server
        .operations()
        .forAccount(accountId)
        .limit(limit)
        .order('desc')
        .call();

      return page.records as unknown[];
    },
    async fetchTransactionOperations(transactionHash: string, limit: number): Promise<unknown[]> {
      const page = await server.operations().forTransaction(transactionHash).limit(limit).call();

      return page.records as unknown[];
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2: inspection
// ---------------------------------------------------------------------------

export function parseAccountRecord(raw: unknown): ParsedAccountRecord {
  const warnings: AuditWarning[] = [];

  const empty: ParsedAccountRecord = {
    accountId: null,
    sequence: null,
    inflationDestination: null,
    inflationDestinationFieldPresent: false,
    homeDomain: null,
    subentryCount: null,
    lastModifiedLedger: null,
    malformed: true,
    warnings,
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({
      field: 'account',
      message: 'The account response was not an object, so no configuration could be read.',
    });

    return empty;
  }

  const record = raw as Record<string, unknown>;

  const accountId = stringValue(record.account_id) ?? stringValue(record.accountId);
  const sequence = sequenceValue(record.sequence ?? record.sequenceNumber);

  let malformed = false;

  if (!accountId) {
    warnings.push({
      field: 'account.account_id',
      message: 'The account response did not contain an account ID.',
    });
    malformed = true;
  } else if (!isValidAccountId(accountId)) {
    warnings.push({
      field: 'account.account_id',
      message: `The account response contained an invalid account ID: ${accountId}`,
    });
    malformed = true;
  }

  if (!sequence) {
    warnings.push({
      field: 'account.sequence',
      message: 'The account response did not contain a usable sequence number.',
    });
    malformed = true;
  }

  const fieldPresent =
    Object.prototype.hasOwnProperty.call(record, 'inflation_dest') ||
    Object.prototype.hasOwnProperty.call(record, 'inflation_destination');

  const inflationDestination =
    stringValue(record.inflation_dest) ?? stringValue(record.inflation_destination);

  return {
    accountId,
    sequence,
    inflationDestination,
    inflationDestinationFieldPresent: fieldPresent,
    homeDomain: stringValue(record.home_domain),
    subentryCount: numberValue(record.subentry_count),
    lastModifiedLedger: numberValue(record.last_modified_ledger),
    malformed,
    warnings,
  };
}

/**
 * Validate an inflation destination using the SDK's StrKey helpers.
 *
 * Inflation destination is an AccountID (ed25519 `G...`). Muxed `M...` addresses
 * are valid StrKeys but cannot be stored in this field.
 */
export function validateInflationDestination(value: string | null): DestinationValidation {
  if (value === null || value.trim().length === 0) {
    return {
      provided: false,
      value: null,
      valid: null,
      format: 'none',
      reason: null,
    };
  }

  const destination = value.trim();

  if (StrKey.isValidEd25519PublicKey(destination)) {
    return {
      provided: true,
      value: destination,
      valid: true,
      format: 'ed25519-account',
      reason: null,
    };
  }

  if (StrKey.isValidMed25519PublicKey(destination)) {
    return {
      provided: true,
      value: destination,
      valid: false,
      format: 'muxed-account',
      reason:
        'Muxed (M...) addresses are valid StrKeys but cannot be used as an inflation ' +
        'destination; an ed25519 G... account is required.',
    };
  }

  return {
    provided: true,
    value: destination,
    valid: false,
    format: 'invalid',
    reason: 'The configured destination is not a valid Stellar StrKey account address.',
  };
}

export function inspectInflationDestination(
  account: ParsedAccountRecord,
): InflationDestinationInspection {
  const validation = validateInflationDestination(account.inflationDestination);

  return {
    fieldReturned: account.inflationDestinationFieldPresent,
    destination: account.inflationDestination,
    validation,
    configured: validation.provided,
    operational: false,
    explanation: validation.provided
      ? 'The account still carries a legacy inflation destination. This is historical ' +
        'configuration; it does not route payments or entitle the destination to rewards.'
      : 'The account has no configured inflation destination. The inflation mechanism is ' +
        'disabled for all accounts regardless of this field.',
  };
}

export function checkNetworkConfiguration(
  configuredPassphrase: string,
  endpointPassphrase: string | null,
): NetworkConfigurationCheck {
  const configuredNetwork = networkName(configuredPassphrase);
  const endpointNetwork = networkName(endpointPassphrase);
  const warnings: string[] = [];

  const checked = endpointPassphrase !== null;
  const mismatch = checked && endpointPassphrase !== configuredPassphrase;

  if (!checked) {
    warnings.push(
      'The Horizon endpoint did not report a network passphrase, so the account data could not ' +
        'be matched against the configured network.',
    );
  } else if (mismatch) {
    warnings.push(
      `Network configuration mismatch: Horizon reports ${endpointNetwork ?? 'a custom network'} ` +
        `(${endpointPassphrase}) but the configured passphrase is ` +
        `${configuredNetwork ?? 'a custom network'} (${configuredPassphrase}). ` +
        'The account belongs to the endpoint network; do not use this data to build ' +
        'transactions for the configured network.',
    );
  }

  return {
    configuredPassphrase,
    configuredNetwork,
    endpointPassphrase,
    endpointNetwork,
    checked,
    mismatch,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: historical configuration changes
// ---------------------------------------------------------------------------

/**
 * Extract historical operations that set an inflation destination.
 *
 * Horizon's current operation schema no longer documents the field, so records
 * are read defensively and every value is validated before being reported.
 */
export function extractInflationDestinationChanges(
  operations: unknown[],
  accountId: string | null,
): { changes: HistoricalConfigurationChange[]; examinedOperations: number } {
  const changes: HistoricalConfigurationChange[] = [];

  operations.forEach((raw) => {
    if (raw === null || typeof raw !== 'object') {
      return;
    }

    const operation = raw as Record<string, unknown>;
    const type = stringValue(operation.type);

    if (type !== 'set_options' && type !== 'setOptions') {
      return;
    }

    const sourceAccount = stringValue(operation.source_account);

    /*
     * In account mode the operation source is the account whose configuration
     * changed. Operations that only touch another account are not this account's
     * configuration history.
     */
    if (accountId && sourceAccount && sourceAccount !== accountId) {
      return;
    }

    const destination =
      stringValue(operation.inflation_dest) ?? stringValue(operation.inflation_destination);

    if (!destination) {
      return;
    }

    const validation = validateInflationDestination(destination);

    changes.push({
      operationType: type,
      createdAt: stringValue(operation.created_at),
      ledger: numberValue(operation.ledger),
      transactionHash: stringValue(operation.transaction_hash),
      sourceAccount,
      inflationDestination: destination,
      destinationValid: validation.valid === true,
      summary:
        `Set legacy inflation destination to ${destination} ` +
        `(${validation.valid ? 'valid ed25519 account' : 'invalid destination'}).`,
    });
  });

  changes.sort(compareChronologically);

  return { changes, examinedOperations: operations.length };
}

// ---------------------------------------------------------------------------
// Stage 4: reporting
// ---------------------------------------------------------------------------

export async function auditAccount(
  options: AuditOptions,
  injected?: AccountAuditDeps,
): Promise<AccountAuditReport> {
  const accountId = options.accountId.trim();

  const horizonUrl =
    options.horizonUrl?.trim() || process.env.HORIZON_URL?.trim() || DEFAULT_HORIZON_URL;

  const networkPassphrase =
    options.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

  const deps = injected ?? createHorizonAuditDeps(horizonUrl);

  if (!isValidAccountId(accountId)) {
    const warnings: AuditWarning[] = [
      {
        field: 'accountId',
        message: 'The supplied value is not a valid ed25519 Stellar account public key (G...).',
      },
    ];

    return {
      accountId,
      horizonUrl: deps.horizonUrl,
      network: networkName(networkPassphrase),
      networkPassphrase,
      account: emptyAccountState(false),
      inflationDestination: {
        fieldReturned: false,
        destination: null,
        validation: validateInflationDestination(null),
        configured: false,
        operational: false,
        explanation: 'No account was inspected because the account ID is invalid.',
      },
      networkCheck: {
        configuredPassphrase: networkPassphrase,
        configuredNetwork: networkName(networkPassphrase),
        endpointPassphrase: null,
        endpointNetwork: null,
        checked: false,
        mismatch: false,
        warnings: ['Network configuration was not checked because the account ID is invalid.'],
      },
      history: {
        status: 'not-requested',
        scope: 'none',
        examinedOperations: 0,
        changes: [],
        warnings: ['History was not inspected because the account ID is invalid.'],
      },
      legacyNotice: LEGACY_INFLATION_NOTICE,
      status: 'error',
      warnings,
      unavailable: ['account', 'network', 'history'],
    };
  }

  const warnings: AuditWarning[] = [];
  const unavailable: string[] = [];

  // -- Network passphrase reported by the endpoint -------------------------
  let endpointPassphrase: string | null = null;

  try {
    endpointPassphrase = await deps.fetchNetworkPassphrase();
  } catch (error: unknown) {
    warnings.push({
      field: 'networkCheck',
      message: `Could not read the Horizon network passphrase: ${getErrorMessage(error)}`,
    });
    unavailable.push('network.endpointPassphrase');
  }

  const networkCheck = checkNetworkConfiguration(networkPassphrase, endpointPassphrase);

  if (!networkCheck.checked && !unavailable.includes('network.endpointPassphrase')) {
    unavailable.push('network.endpointPassphrase');
  }

  networkCheck.warnings.forEach((message) => {
    warnings.push({ field: 'networkCheck', message });
  });

  // -- Account configuration ----------------------------------------------
  let rawAccount: unknown;

  try {
    rawAccount = await deps.fetchAccount(accountId);
  } catch (error: unknown) {
    const notFound = error instanceof AccountNotFoundError;

    warnings.push({
      field: 'account',
      message: notFound
        ? `The account was not found on this Horizon endpoint. It may not exist on this ` +
          `network, may have been merged, or the endpoint/network pair may be wrong.`
        : `The account request failed: ${getErrorMessage(error)}`,
    });

    return {
      accountId,
      horizonUrl: deps.horizonUrl,
      network: networkName(networkPassphrase),
      networkPassphrase,
      account: emptyAccountState(false),
      inflationDestination: {
        fieldReturned: false,
        destination: null,
        validation: validateInflationDestination(null),
        configured: false,
        operational: false,
        explanation: notFound
          ? 'No account configuration was inspected because the account does not exist.'
          : 'No account configuration was inspected because the request failed.',
      },
      networkCheck,
      history: {
        status: 'unavailable',
        scope: 'none',
        examinedOperations: 0,
        changes: [],
        warnings: ['History was not inspected because the account could not be retrieved.'],
      },
      legacyNotice: LEGACY_INFLATION_NOTICE,
      status: notFound ? 'not-found' : 'error',
      warnings,
      unavailable: [...unavailable, 'account', 'history'],
    };
  }

  const parsed = parseAccountRecord(rawAccount);
  warnings.push(...parsed.warnings);

  if (parsed.malformed) {
    unavailable.push('account.configuration');
  }

  /*
   * An absent inflation destination field is normal and is not added to
   * `unavailable`: it must not be confused with a retrieval failure.
   */
  const inflationDestination = inspectInflationDestination(parsed);

  if (inflationDestination.validation.provided && !inflationDestination.validation.valid) {
    unavailable.push('inflationDestination.valid');
    warnings.push({
      field: 'inflationDestination',
      message:
        inflationDestination.validation.reason ??
        'The configured inflation destination could not be validated.',
    });
  }

  if (inflationDestination.configured) {
    warnings.push({
      field: 'inflationDestination',
      message:
        'Legacy inflation destination is configured on this account. Inflation is disabled; ' +
        'this configuration does not create rewards or payment routing.',
    });
  }

  // -- Historical configuration -------------------------------------------
  const history = await inspectHistory(options, accountId, deps);

  history.warnings.forEach((message) => {
    warnings.push({ field: 'history', message });
  });

  if (history.status === 'unavailable') {
    unavailable.push('history');
  }

  const status = computeAuditStatus(parsed, inflationDestination, networkCheck, history);

  if (status === 'ok' && warnings.length > 0) {
    // Unknown warnings still make the audit advisory rather than silently clean.
    return finalize('warning');
  }

  return finalize(status);

  function finalize(finalStatus: AuditStatus): AccountAuditReport {
    return {
      accountId,
      horizonUrl: deps.horizonUrl,
      network: networkName(networkPassphrase),
      networkPassphrase,
      account: {
        exists: true,
        sequence: parsed.sequence,
        homeDomain: parsed.homeDomain,
        subentryCount: parsed.subentryCount,
        lastModifiedLedger: parsed.lastModifiedLedger,
      },
      inflationDestination,
      networkCheck,
      history,
      legacyNotice: LEGACY_INFLATION_NOTICE,
      status: finalStatus,
      warnings,
      unavailable,
    };
  }
}

async function inspectHistory(
  options: AuditOptions,
  accountId: string,
  deps: AccountAuditDeps,
): Promise<HistoryAudit> {
  const transactionHash = options.transactionHash?.trim();
  const includeHistory = options.includeHistory === true || options.includeHistory === 'true';

  if (!transactionHash && !includeHistory) {
    return {
      status: 'not-requested',
      scope: 'none',
      examinedOperations: 0,
      changes: [],
      warnings: [],
    };
  }

  const limit = resolveHistoryLimit(options.historyLimit);

  if (transactionHash) {
    if (!/^[0-9a-fA-F]{64}$/.test(transactionHash)) {
      return {
        status: 'unavailable',
        scope: 'transaction',
        examinedOperations: 0,
        changes: [],
        warnings: [
          `Historical inspection was skipped: "${transactionHash}" is not a 64-character transaction hash.`,
        ],
      };
    }

    if (!deps.fetchTransactionOperations) {
      return {
        status: 'unavailable',
        scope: 'transaction',
        examinedOperations: 0,
        changes: [],
        warnings: ['This data source cannot retrieve operations for a transaction.'],
      };
    }

    try {
      const operations = await deps.fetchTransactionOperations(transactionHash, limit);
      const extracted = extractInflationDestinationChanges(operations, accountId);

      return {
        status: extracted.changes.length > 0 ? 'retrieved' : 'empty',
        scope: 'transaction',
        examinedOperations: extracted.examinedOperations,
        changes: extracted.changes,
        warnings:
          extracted.changes.length > 0
            ? []
            : [
                'The transaction was retrieved but no inflation destination change was found ' +
                  'in its operations.',
              ],
      };
    } catch (error: unknown) {
      return {
        status: 'unavailable',
        scope: 'transaction',
        examinedOperations: 0,
        changes: [],
        warnings: [`Historical operations could not be retrieved: ${getErrorMessage(error)}`],
      };
    }
  }

  if (!deps.fetchAccountOperations) {
    return {
      status: 'unavailable',
      scope: 'account',
      examinedOperations: 0,
      changes: [],
      warnings: ['This data source cannot retrieve account operations.'],
    };
  }

  try {
    const operations = await deps.fetchAccountOperations(accountId, limit);
    const extracted = extractInflationDestinationChanges(operations, accountId);

    return {
      status: extracted.changes.length > 0 ? 'retrieved' : 'empty',
      scope: 'account',
      examinedOperations: extracted.examinedOperations,
      changes: extracted.changes,
      warnings:
        extracted.changes.length > 0
          ? []
          : [
              `The last ${extracted.examinedOperations} operation(s) were examined, but no ` +
                'inflation destination changes were found. Older history may exist beyond the ' +
                'retrieved range.',
            ],
    };
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      scope: 'account',
      examinedOperations: 0,
      changes: [],
      warnings: [`Historical operations could not be retrieved: ${getErrorMessage(error)}`],
    };
  }
}

function computeAuditStatus(
  parsed: ParsedAccountRecord,
  destination: InflationDestinationInspection,
  networkCheck: NetworkConfigurationCheck,
  history: HistoryAudit,
): AuditStatus {
  if (parsed.malformed) {
    return 'error';
  }

  if (destination.validation.provided && !destination.validation.valid) {
    return 'error';
  }

  if (
    destination.configured ||
    networkCheck.mismatch ||
    !networkCheck.checked ||
    history.status === 'unavailable' ||
    history.status === 'empty'
  ) {
    return 'warning';
  }

  return 'ok';
}

export function formatAuditReport(report: AccountAuditReport): string {
  const lines: string[] = [];

  lines.push(chalk.bold('\n========== ACCOUNT CONFIGURATION AUDIT =========='));
  lines.push(`Account public key : ${report.accountId}`);
  lines.push(`Network            : ${describeNetwork(report)}`);
  lines.push(`Horizon endpoint   : ${report.horizonUrl}`);
  lines.push(`Account exists     : ${report.account.exists ? 'yes' : 'no'}`);
  lines.push(`Sequence number    : ${report.account.sequence ?? '(not available)'}`);
  lines.push(`Home domain        : ${report.account.homeDomain ?? '(none)'}`);
  lines.push(`Subentries         : ${report.account.subentryCount ?? '(not available)'}`);
  lines.push(
    `Last modified      : ${
      report.account.lastModifiedLedger !== null
        ? `ledger ${report.account.lastModifiedLedger}`
        : '(not available)'
    }`,
  );

  // -------------------------------------------------------------------------
  // Legacy inflation destination
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nLegacy inflation destination'));
  lines.push(
    `  Field returned         : ${report.inflationDestination.fieldReturned ? 'yes' : 'no'}`,
  );
  lines.push(`  Configured destination : ${report.inflationDestination.destination ?? '(none)'}`);
  lines.push(`  Destination valid      : ${describeDestinationValidation(report)}`);

  if (report.inflationDestination.destination) {
    lines.push(`  Destination format     : ${report.inflationDestination.validation.format}`);
  }

  lines.push(
    `  Operational inflation  : no (legacy configuration only; the mechanism is disabled)`,
  );
  lines.push(`  Explanation            : ${report.inflationDestination.explanation}`);
  lines.push(`  Legacy notice          : ${report.legacyNotice}`);

  // -------------------------------------------------------------------------
  // Network configuration
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nNetwork configuration'));
  lines.push(`  Configured passphrase  : ${report.networkPassphrase}`);
  lines.push(`  Configured network     : ${report.network ?? 'unknown'}`);
  lines.push(
    `  Endpoint passphrase    : ${report.networkCheck.endpointPassphrase ?? '(not reported)'}`,
  );
  lines.push(`  Endpoint network       : ${report.networkCheck.endpointNetwork ?? 'unknown'}`);
  lines.push(`  Verified               : ${report.networkCheck.checked ? 'yes' : 'no'}`);
  lines.push(
    `  Mismatch               : ${
      report.networkCheck.mismatch ? 'YES (configured network differs from endpoint network)' : 'no'
    }`,
  );

  // -------------------------------------------------------------------------
  // Historical configuration
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nHistorical configuration changes'));
  lines.push(`  Status                 : ${report.history.status}`);
  lines.push(`  Scope                  : ${describeHistoryScope(report.history)}`);
  lines.push(`  Operations examined    : ${report.history.examinedOperations}`);
  lines.push(`  Configuration changes  : ${report.history.changes.length}`);

  report.history.changes.slice(0, 25).forEach((change) => {
    lines.push(
      `    - ${change.createdAt ?? '(no timestamp)'}` +
        `${change.ledger !== null ? ` ledger=${change.ledger}` : ''}` +
        `${change.transactionHash ? ` tx=${change.transactionHash}` : ''}`,
    );
    lines.push(`        ${change.summary}`);
  });

  if (report.history.changes.length > 25) {
    lines.push('    ... additional changes in the JSON export');
  }

  // -------------------------------------------------------------------------
  // Status and gaps
  // -------------------------------------------------------------------------
  lines.push(chalk.bold('\nAudit result'));
  lines.push(`  Overall status         : ${report.status.toUpperCase()}`);

  lines.push('  Warnings:');
  if (report.warnings.length === 0) {
    lines.push('    (none)');
  } else {
    report.warnings.forEach((warning) => {
      lines.push(`    - [${warning.field}] ${warning.message}`);
    });
  }

  lines.push('  Unavailable:');
  if (report.unavailable.length === 0) {
    lines.push('    (none)');
  } else {
    report.unavailable.forEach((field) => lines.push(`    - ${field}`));
  }

  lines.push(chalk.bold('================================================='));

  return lines.join('\n');
}

export function auditReportToJson(report: AccountAuditReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function run(params: AuditParams = {}): Promise<void> {
  const positional = process.argv[3]?.trim() ?? '';
  const positionalAccount = isValidAccountId(positional) ? positional : '';

  const accountId = params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || positionalAccount;

  console.log(
    chalk.bold('\nStellar Account Inflation Destination & Network Configuration Auditor'),
  );
  console.log(
    chalk.gray(
      'Audits legacy inflation configuration and network settings without implying ' +
        'that inflation is operational.',
    ),
  );

  if (!accountId) {
    console.log(chalk.yellow('\nNo account ID supplied.'));
    console.log(
      chalk.gray('  Usage: ACCOUNT_ID=<G...> npm run run-example 263-inflation-destination-audit'),
    );
    return;
  }

  const includeHistory =
    params.includeHistory === true ||
    params.includeHistory === 'true' ||
    (process.env.AUDIT_HISTORY ?? '').toLowerCase() === 'true' ||
    process.argv.slice(2).includes('--history');

  const json =
    params.json === true || params.json === 'true' || process.argv.slice(2).includes('--json');

  const transactionHash = params.transactionHash?.trim() || process.env.AUDIT_TRANSACTION_HASH;

  const report = await auditAccount({
    accountId,
    horizonUrl: params.horizonUrl,
    networkPassphrase: params.networkPassphrase,
    includeHistory,
    transactionHash,
    historyLimit: params.historyLimit,
  });

  if (json) {
    console.log(auditReportToJson(report));
  } else {
    console.log(formatAuditReport(report));
  }

  if (report.status === 'error' && !report.account.exists) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyAccountState(exists: boolean): AccountAuditReport['account'] {
  return {
    exists,
    sequence: null,
    homeDomain: null,
    subentryCount: null,
    lastModifiedLedger: null,
  };
}

export function networkName(passphrase: string | null): string | null {
  if (!passphrase) {
    return null;
  }

  const known = KNOWN_NETWORKS.find((network) => network.passphrase === passphrase);

  return known ? known.name : 'custom';
}

function resolveHistoryLimit(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(Math.floor(parsed), MAX_HISTORY_LIMIT);
}

function compareChronologically(
  left: HistoricalConfigurationChange,
  right: HistoricalConfigurationChange,
): number {
  const leftTime = left.createdAt ?? '';
  const rightTime = right.createdAt ?? '';

  if (leftTime !== rightTime) {
    return leftTime.localeCompare(rightTime);
  }

  return (left.ledger ?? Number.MAX_SAFE_INTEGER) - (right.ledger ?? Number.MAX_SAFE_INTEGER);
}

function describeNetwork(report: AccountAuditReport): string {
  return `${report.network ?? 'unknown'} (${report.networkPassphrase})`;
}

function describeDestinationValidation(report: AccountAuditReport): string {
  const validation = report.inflationDestination.validation;

  if (!validation.provided) {
    return 'not applicable (no destination configured)';
  }

  return validation.valid ? 'yes' : `no - ${validation.reason ?? 'invalid destination'}`;
}

function describeHistoryScope(history: HistoryAudit): string {
  if (history.scope === 'transaction') {
    return 'single transaction';
  }

  if (history.scope === 'account') {
    return 'recent account operations';
  }

  return 'not requested';
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function sequenceValue(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function isHttpNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const response = (error as { response?: { status?: number } }).response;

  return response?.status === 404;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}
