import * as fs from 'fs';
import * as path from 'path';

import { Networks } from '@stellar/stellar-sdk';

import {
  AccountNotFoundError,
  DEFAULT_HISTORY_LIMIT,
  LEGACY_INFLATION_NOTICE,
  auditAccount,
  auditReportToJson,
  checkNetworkConfiguration,
  extractInflationDestinationChanges,
  formatAuditReport,
  inspectInflationDestination,
  isValidAccountId,
  networkName,
  parseAccountRecord,
  validateInflationDestination,
} from '../src/examples/263-inflation-destination-audit';

import type {
  AccountAuditDeps,
  AccountAuditReport,
  AuditOptions,
} from '../src/examples/263-inflation-destination-audit';

const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const DESTINATION = 'GBTL47RTFR5EKMZSXWOQU735WBK7LRPPDIDK3JTNTCZZ7NUBBRDTVSK2';
const OTHER_DESTINATION = 'GAFVCOWZWSJEAFOKBEBO2B4QITJ2YXN6YIYG6BUURQINVDVW4OPS3OL6';
const MUXED_ADDRESS = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'inflation-destination-audit');

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
}

interface DepsOptions {
  account?: unknown;
  accountError?: Error;
  passphrase?: string | null;
  passphraseError?: Error;
  operations?: unknown[];
  operationsError?: Error;
  transactionOperations?: unknown[];
  transactionOperationsError?: Error;
}

function makeDeps(options: DepsOptions = {}): AccountAuditDeps {
  return {
    horizonUrl: 'https://horizon-testnet.example.test',
    async fetchAccount() {
      if (options.accountError) {
        throw options.accountError;
      }

      return options.account ?? fixture('account-without-destination');
    },
    async fetchNetworkPassphrase() {
      if (options.passphraseError) {
        throw options.passphraseError;
      }

      return options.passphrase === undefined ? Networks.TESTNET : options.passphrase;
    },
    async fetchAccountOperations() {
      if (options.operationsError) {
        throw options.operationsError;
      }

      return options.operations ?? [];
    },
    async fetchTransactionOperations() {
      if (options.transactionOperationsError) {
        throw options.transactionOperationsError;
      }

      return options.transactionOperations ?? [];
    },
  };
}

function audit(
  options: Partial<AuditOptions> = {},
  deps: AccountAuditDeps = makeDeps(),
): Promise<AccountAuditReport> {
  return auditAccount(
    {
      accountId: ACCOUNT_ID,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: deps.horizonUrl,
      ...options,
    },
    deps,
  );
}

describe('inflation destination auditor', () => {
  describe('account retrieval', () => {
    it('retrieves account configuration and reports the network', async () => {
      const report = await audit();

      expect(report.account.exists).toBe(true);
      expect(report.account.sequence).toBe('1070000000000000000');
      expect(report.account.homeDomain).toBe('example.com');
      expect(report.network).toBe('testnet');
      expect(report.networkPassphrase).toBe(Networks.TESTNET);
      expect(report.horizonUrl).toBe('https://horizon-testnet.example.test');
      expect(report.status).toBe('ok');
    });

    it('reports a missing account instead of inventing configuration', async () => {
      const report = await audit(
        {},
        makeDeps({
          accountError: new AccountNotFoundError('no account'),
        }),
      );

      expect(report.account.exists).toBe(false);
      expect(report.status).toBe('not-found');
      expect(report.unavailable).toContain('account');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'was not found',
      );
    });

    it('reports a Horizon request failure without claiming the account is absent', async () => {
      const report = await audit(
        {},
        makeDeps({
          accountError: new Error('Horizon request failed: socket hang up'),
        }),
      );

      expect(report.account.exists).toBe(false);
      expect(report.status).toBe('error');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'socket hang up',
      );
    });

    it('handles a malformed account response defensively', async () => {
      const report = await audit({}, makeDeps({ account: fixture('account-malformed') }));

      expect(report.account.exists).toBe(true);
      expect(report.account.sequence).toBeNull();
      expect(report.status).toBe('error');
      expect(report.unavailable).toContain('account.configuration');
      expect(report.warnings.map((warning) => warning.field)).toContain('account.sequence');
    });

    it('rejects an invalid account ID before calling Horizon', async () => {
      const fetchAccount = jest.fn();

      const report = await auditAccount(
        { accountId: 'GNOTVALID', networkPassphrase: Networks.TESTNET },
        { ...makeDeps(), fetchAccount },
      );

      expect(fetchAccount).not.toHaveBeenCalled();
      expect(report.status).toBe('error');
      expect(report.account.exists).toBe(false);
      expect(report.unavailable).toContain('account');
      expect(isValidAccountId(ACCOUNT_ID)).toBe(true);
      expect(isValidAccountId('GNOTVALID')).toBe(false);
    });
  });

  describe('legacy inflation destination inspection', () => {
    it('handles an account with no inflation destination field', async () => {
      const report = await audit();

      expect(report.inflationDestination.fieldReturned).toBe(false);
      expect(report.inflationDestination.destination).toBeNull();
      expect(report.inflationDestination.configured).toBe(false);
      expect(report.inflationDestination.validation.valid).toBeNull();
      expect(report.inflationDestination.operational).toBe(false);
      expect(report.unavailable).not.toContain('inflationDestination.valid');
      expect(report.status).toBe('ok');
    });

    it('distinguishes a returned field with a null value from a missing field', async () => {
      const report = await audit({}, makeDeps({ account: fixture('account-null-destination') }));

      expect(report.inflationDestination.fieldReturned).toBe(true);
      expect(report.inflationDestination.destination).toBeNull();
      expect(report.inflationDestination.configured).toBe(false);
      expect(report.status).toBe('ok');
    });

    it('inspects a configured legacy destination and warns that inflation is disabled', async () => {
      const report = await audit({}, makeDeps({ account: fixture('account-with-destination') }));

      expect(report.inflationDestination.fieldReturned).toBe(true);
      expect(report.inflationDestination.configured).toBe(true);
      expect(report.inflationDestination.destination).toBe(DESTINATION);
      expect(report.inflationDestination.validation.valid).toBe(true);
      expect(report.inflationDestination.validation.format).toBe('ed25519-account');
      expect(report.status).toBe('warning');
      expect(report.legacyNotice).toContain('disabled since protocol 12');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'Inflation is disabled',
      );
    });

    it('flags an invalid destination address stored on the account', async () => {
      const report = await audit({}, makeDeps({ account: fixture('account-invalid-destination') }));

      expect(report.inflationDestination.configured).toBe(true);
      expect(report.inflationDestination.validation.valid).toBe(false);
      expect(report.inflationDestination.validation.format).toBe('invalid');
      expect(report.status).toBe('error');
      expect(report.unavailable).toContain('inflationDestination.valid');
    });

    it('rejects a muxed address as an inflation destination', () => {
      const validation = validateInflationDestination(MUXED_ADDRESS);

      expect(validation.provided).toBe(true);
      expect(validation.valid).toBe(false);
      expect(validation.format).toBe('muxed-account');
      expect(validation.reason).toContain('Muxed');
    });

    it('marks the mechanism as non-operational even when a destination exists', () => {
      const parsed = parseAccountRecord(fixture('account-with-destination'));
      const inspection = inspectInflationDestination(parsed);

      expect(inspection.operational).toBe(false);
      expect(inspection.explanation).toContain('historical configuration');
    });
  });

  describe('network configuration', () => {
    it('accepts a matching endpoint passphrase', async () => {
      const report = await audit();

      expect(report.networkCheck.checked).toBe(true);
      expect(report.networkCheck.mismatch).toBe(false);
      expect(report.networkCheck.endpointNetwork).toBe('testnet');
    });

    it('detects a network configuration mismatch', async () => {
      const report = await audit({}, makeDeps({ passphrase: Networks.PUBLIC }));

      expect(report.networkCheck.checked).toBe(true);
      expect(report.networkCheck.mismatch).toBe(true);
      expect(report.networkCheck.endpointNetwork).toBe('mainnet');
      expect(report.status).toBe('warning');
      expect(report.warnings.map((warning) => warning.message).join(' ')).toContain(
        'Network configuration mismatch',
      );
    });

    it('reports an unverifiable network without failing the audit', async () => {
      const report = await audit(
        {},
        makeDeps({ passphraseError: new Error('root endpoint unavailable') }),
      );

      expect(report.networkCheck.checked).toBe(false);
      expect(report.status).toBe('warning');
      expect(report.unavailable).toContain('network.endpointPassphrase');
    });

    it('names known networks and treats others as custom', () => {
      expect(networkName(Networks.PUBLIC)).toBe('mainnet');
      expect(networkName(Networks.TESTNET)).toBe('testnet');
      expect(networkName('A custom network')).toBe('custom');
      expect(networkName(null)).toBeNull();

      const check = checkNetworkConfiguration(Networks.TESTNET, null);

      expect(check.checked).toBe(false);
      expect(check.warnings[0]).toContain('did not report a network passphrase');
    });
  });

  describe('historical configuration changes', () => {
    it('retrieves and orders inflation destination changes chronologically', async () => {
      const report = await audit(
        { includeHistory: true },
        makeDeps({ operations: fixture('operations-inflation-changes') }),
      );

      expect(report.history.status).toBe('retrieved');
      expect(report.history.scope).toBe('account');
      expect(report.history.examinedOperations).toBe(5);
      expect(report.history.changes).toHaveLength(2);
      expect(report.history.changes[0].createdAt).toBe('2020-01-01T00:00:00Z');
      expect(report.history.changes[0].inflationDestination).toBe(DESTINATION);
      expect(report.history.changes[1].createdAt).toBe('2020-02-01T00:00:00Z');
      expect(report.history.changes[1].inflationDestination).toBe(OTHER_DESTINATION);
      expect(report.history.changes[0].destinationValid).toBe(true);
    });

    it('reports empty historical results clearly', async () => {
      const report = await audit(
        { includeHistory: true },
        makeDeps({ operations: fixture('operations-inflation-changes') }),
      );

      const emptyReport = await audit({ includeHistory: true }, makeDeps({ operations: [] }));

      expect(report.history.status).toBe('retrieved');
      expect(emptyReport.history.status).toBe('empty');
      expect(emptyReport.history.changes).toHaveLength(0);
      expect(emptyReport.history.warnings[0]).toContain('no inflation destination changes');
      expect(emptyReport.status).toBe('warning');
    });

    it('reports unavailable history without failing the whole audit', async () => {
      const report = await audit(
        { includeHistory: true },
        makeDeps({ operationsError: new Error('history endpoint unavailable') }),
      );

      expect(report.history.status).toBe('unavailable');
      expect(report.history.warnings[0]).toContain('history endpoint unavailable');
      expect(report.unavailable).toContain('history');
      expect(report.status).toBe('warning');
    });

    it('supports inspecting a single transaction', async () => {
      const transactionHash = 'a'.repeat(64);
      const fetchTransactionOperations = jest.fn(async (): Promise<unknown[]> =>
        fixture('operations-inflation-changes'),
      );

      const report = await audit(
        { transactionHash },
        { ...makeDeps(), fetchTransactionOperations },
      );

      expect(fetchTransactionOperations).toHaveBeenCalledWith(
        transactionHash,
        DEFAULT_HISTORY_LIMIT,
      );
      expect(report.history.scope).toBe('transaction');
      expect(report.history.status).toBe('retrieved');
      expect(report.history.changes).toHaveLength(2);
    });

    it('rejects an invalid transaction hash for history inspection', async () => {
      const report = await audit({ transactionHash: 'not-a-hash' });

      expect(report.history.status).toBe('unavailable');
      expect(report.history.warnings[0]).toContain('not a 64-character transaction hash');
    });

    it('does not request history unless asked', async () => {
      const fetchAccountOperations = jest.fn(async () => []);
      const report = await audit({}, { ...makeDeps(), fetchAccountOperations });

      expect(fetchAccountOperations).not.toHaveBeenCalled();
      expect(report.history.status).toBe('not-requested');
      expect(report.history.scope).toBe('none');
    });

    it('ignores non-configuration and third-party operations', () => {
      const extracted = extractInflationDestinationChanges(
        fixture('operations-inflation-changes'),
        ACCOUNT_ID,
      );

      expect(extracted.examinedOperations).toBe(5);
      expect(extracted.changes.every((change) => change.operationType === 'set_options')).toBe(
        true,
      );
      expect(extracted.changes.every((change) => change.sourceAccount === ACCOUNT_ID)).toBe(true);
    });
  });

  describe('reports and export', () => {
    it('builds a human-readable report with every required section', async () => {
      const report = await audit(
        { includeHistory: true },
        makeDeps({
          account: fixture('account-with-destination'),
          operations: fixture('operations-inflation-changes'),
        }),
      );

      const text = formatAuditReport(report);

      expect(text).toContain('ACCOUNT CONFIGURATION AUDIT');
      expect(text).toContain(report.accountId);
      expect(text).toContain('Network');
      expect(text).toContain('Account exists');
      expect(text).toContain('Legacy inflation destination');
      expect(text).toContain(DESTINATION);
      expect(text).toContain('Destination valid');
      expect(text).toContain('Network configuration');
      expect(text).toContain('Mismatch');
      expect(text).toContain('Historical configuration changes');
      expect(text).toContain('2020-01-01T00:00:00Z');
      expect(text).toContain('Legacy notice');
      expect(text).toContain('WARNING');
    });

    it('serializes the audit report to JSON', async () => {
      const report = await audit({}, makeDeps({ account: fixture('account-with-destination') }));

      const parsed = JSON.parse(auditReportToJson(report)) as AccountAuditReport;

      expect(parsed.accountId).toBe(ACCOUNT_ID);
      expect(parsed.inflationDestination.destination).toBe(DESTINATION);
      expect(parsed.inflationDestination.operational).toBe(false);
      expect(parsed.legacyNotice).toBe(LEGACY_INFLATION_NOTICE);
      expect(parsed.status).toBe('warning');
      expect(parsed.networkCheck.configuredNetwork).toBe('testnet');
      expect(() => JSON.stringify(parsed)).not.toThrow();
    });

    it('always includes the legacy warning, even without a destination', async () => {
      const report = await audit();

      expect(report.legacyNotice).toContain('does not currently distribute inflation rewards');
      expect(formatAuditReport(report)).toContain('Operational inflation  : no');
    });
  });
});
