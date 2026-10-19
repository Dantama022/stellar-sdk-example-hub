import { Horizon, Networks } from '@stellar/stellar-sdk';

/**
 * Example 261: Stellar Network Configuration and Transaction Safety Checks
 *
 * Demonstrates how to configure network connections safely, validate
 * network passphrases/endpoints, and verify transaction network settings
 * before preparation or submission.
 *
 * This example performs read-only checks and builds nothing for Mainnet.
 * It never signs with a real secret key and never submits transactions.
 * The pre-submission gate composes endpoint validation, passphrase checks,
 * and transaction-field safety checks into one reusable report.
 */

export type StellarNetworkName = 'testnet' | 'mainnet';

export interface NetworkSafetyParams {
  network?: string;
  horizonUrl?: string;
  networkPassphrase?: string;
}

export interface NetworkSafetyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface NetworkSafetyReport {
  network: StellarNetworkName | 'unknown';
  horizonUrl: string;
  networkPassphrase: string;
  checks: NetworkSafetyCheck[];
  safeToProceed: boolean;
}

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';

export function normalizeNetworkName(input?: string): StellarNetworkName | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (['testnet', 'test', 'testing'].includes(value)) return 'testnet';
  if (['mainnet', 'main', 'public', 'production'].includes(value)) return 'mainnet';
  return null;
}

export function expectedPassphrase(network: StellarNetworkName): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

export function expectedHorizonUrl(network: StellarNetworkName): string {
  return network === 'mainnet' ? MAINNET_HORIZON : TESTNET_HORIZON;
}

/**
 * Validates endpoint/passphrase pairing and probes the Horizon root for the
 * live network passphrase. Returns a composable pre-submission report.
 */
export async function checkNetworkSafety(
  networkInput?: string,
  horizonUrlInput?: string,
  passphraseInput?: string,
): Promise<NetworkSafetyReport> {
  const network = normalizeNetworkName(networkInput ?? process.env.STELLAR_NETWORK ?? 'testnet') ?? 'testnet';
  const horizonUrl =
    horizonUrlInput ?? process.env.HORIZON_URL ?? expectedHorizonUrl(network as StellarNetworkName);
  const networkPassphrase =
    passphraseInput ?? process.env.NETWORK_PASSPHRASE ?? expectedPassphrase(network as StellarNetworkName);

  const checks: NetworkSafetyCheck[] = [];

  // 1. Passphrase must match the selected network.
  const expected = expectedPassphrase(network as StellarNetworkName);
  checks.push({
    name: 'passphrase-matches-network',
    passed: networkPassphrase === expected,
    detail:
      networkPassphrase === expected
        ? `Passphrase matches ${network}.`
        : `Passphrase does not match ${network}; refusing to proceed (wrong-network signatures are invalid).`,
  });

  // 2. Endpoint should match the selected network (heuristic, not proof).
  const expectedHost = network === 'mainnet' ? 'horizon.stellar.org' : 'horizon-testnet.stellar.org';
  checks.push({
    name: 'endpoint-matches-network',
    passed: horizonUrl.includes(expectedHost),
    detail: horizonUrl.includes(expectedHost)
      ? `Horizon endpoint matches ${network}.`
      : `Horizon endpoint ${horizonUrl} looks inconsistent with ${network}; double-check before preparing transactions.`,
  });

  // 3. Live probe: Horizon root reports the network passphrase it serves.
  try {
    const server = new Horizon.Server(horizonUrl);
    const root = (await server.root().call()) as unknown as { network_passphrase?: string };
    const live = root.network_passphrase;
    if (!live) {
      checks.push({ name: 'horizon-passphrase-probe', passed: false, detail: 'Horizon root did not report a network passphrase.' });
    } else {
      checks.push({
        name: 'horizon-passphrase-probe',
        passed: live === networkPassphrase,
        detail:
          live === networkPassphrase
            ? 'Live Horizon passphrase matches configured passphrase.'
            : `Live passphrase differs from configured passphrase; aborting (configured=${networkPassphrase}, live=${live}).`,
      });
    }
  } catch (error: unknown) {
    checks.push({
      name: 'horizon-passphrase-probe',
      passed: false,
      detail: `Horizon probe failed: ${(error as Error).message}`,
    });
  }

  // 4. Mainnet guard: this teaching example never prepares Mainnet submissions.
  checks.push({
    name: 'mainnet-submission-guard',
    passed: network !== 'mainnet',
    detail:
      network === 'mainnet'
        ? 'Mainnet selected: this example only performs read-only checks and will not build submit-ready transactions.'
        : 'Testnet selected: safe for preparing and inspecting unsigned transactions.',
  });

  const safeToProceed = checks.every((c) => c.passed);
  return { network: network as StellarNetworkName, horizonUrl, networkPassphrase, checks, safeToProceed };
}

/**
 * Verifies transaction-level network settings before preparation/submission.
 * Pure helper: pass the values a builder would use and confirm consistency.
 */
export function verifyTransactionNetworkSettings(args: {
  configuredPassphrase: string;
  expectedNetwork: StellarNetworkName;
  horizonUrl: string;
}): NetworkSafetyCheck[] {
  const expected = expectedPassphrase(args.expectedNetwork);
  return [
    {
      name: 'transaction-passphrase',
      passed: args.configuredPassphrase === expected,
      detail:
        args.configuredPassphrase === expected
          ? `TransactionBuilder passphrase matches ${args.expectedNetwork}.`
          : 'TransactionBuilder passphrase mismatch: the transaction would be rejected or replayable nowhere safely.',
    },
    {
      name: 'transaction-endpoint',
      passed: args.horizonUrl.includes(
        args.expectedNetwork === 'mainnet' ? 'horizon.stellar.org' : 'horizon-testnet.stellar.org',
      ),
      detail: 'Endpoint/network pairing checked before preparation or submission.',
    },
  ];
}

/**
 * Runs the network configuration and safety-check example.
 *
 *   npm run run-example 261-network-pre-submission-checks
 *
 * Environment:
 *   STELLAR_NETWORK (testnet|mainnet), HORIZON_URL, NETWORK_PASSPHRASE
 */
export async function run(params: NetworkSafetyParams = {}): Promise<void> {
  console.log('=== Stellar Network Configuration and Transaction Safety Checks ===');

  const report = await checkNetworkSafety(params.network, params.horizonUrl, params.networkPassphrase);

  console.log(`Network: ${report.network}`);
  console.log(`Horizon: ${report.horizonUrl}`);
  console.log(`Passphrase: ${report.networkPassphrase}`);

  for (const check of report.checks) {
    console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }

  const txChecks = verifyTransactionNetworkSettings({
    configuredPassphrase: report.networkPassphrase,
    expectedNetwork: report.network === 'unknown' ? 'testnet' : report.network,
    horizonUrl: report.horizonUrl,
  });
  for (const check of txChecks) {
    console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }

  if (!report.safeToProceed) {
    console.log('\nSafety gate failed: fix the mismatches above before preparing or submitting anything.');
    return;
  }

  console.log('\nSafety gate passed: endpoint, passphrase, and transaction settings are consistent.');
  console.log('Signatures are network-bound: a Testnet signature is invalid on Mainnet and vice versa.');
}
