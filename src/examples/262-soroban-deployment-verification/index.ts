/**
 * Example 262: Soroban Contract Deployment Verification and Configuration Audit
 *
 * Audits an existing Soroban deployment against a local manifest: the contract
 * must exist on the expected network, reference the expected executable, match
 * the expected Wasm hash where applicable, and expose the expected interface.
 *
 * The example is strictly read-only. It only calls `getNetwork`,
 * `getLatestLedger` and `getLedgerEntries`; it never builds, signs, simulates or
 * submits a transaction.
 *
 * Usage (runner):
 *   npm run run-example 262-soroban-deployment-verification
 *   MANIFEST_ENV=testnet npm run run-example 262-soroban-deployment-verification
 *   MANIFEST_FILE=./manifests/testnet.json npm run run-example 262-soroban-deployment-verification
 *   CONTRACT_ID=C... JSON_OUTPUT=true npm run run-example 262-soroban-deployment-verification
 */

import chalk from 'chalk';
import { rpc } from '@stellar/stellar-sdk';

import { inspectContractInstance } from './contract-inspector';
import type { ContractInstanceInspection, SorobanRpcClient } from './contract-inspector';
import { describeError } from './errors';
import { verifyExecutable } from './executable-verifier';
import { verifyInterfaceAgainstNetwork } from './interface-verifier';
import { SAMPLE_MANIFESTS, loadManifestFile, validateManifest } from './manifest';
import type { DeploymentManifest } from './manifest';
import { checkNetwork } from './network-check';
import { buildDeploymentVerificationReport, formatDeploymentVerificationReport } from './report';
import type { DeploymentVerificationReport } from './report';

export interface RunParams {
  manifestFile?: string;
  environment?: string;
  rpcUrl?: string;
  contractId?: string;
  json?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs the complete audit against an already configured RPC client.
 *
 * Exposed separately from `run` so the orchestration can be tested without a
 * live network. The network passphrase is checked first: when it disagrees with
 * the manifest, contract inspection is skipped because any result from the
 * wrong network would be meaningless.
 */
export async function verifyDeployment(
  client: SorobanRpcClient,
  manifest: DeploymentManifest,
  options: { manifestWarnings?: string[] } = {},
): Promise<DeploymentVerificationReport> {
  const networkCheck = await checkNetwork(client, manifest.network);

  let inspection: ContractInstanceInspection;
  if (networkCheck.status === 'mismatch') {
    inspection = {
      contractId: manifest.contractId,
      status: 'error',
      latestLedger: null,
      lastModifiedLedgerSeq: null,
      liveUntilLedgerSeq: null,
      executable: null,
      error:
        'Contract inspection skipped: the RPC endpoint reports a different network passphrase ' +
        'than the manifest, so its ledger entries are not the expected deployment',
    };
  } else {
    inspection = await inspectContractInstance(client, manifest.contractId);
  }

  const executableVerification = verifyExecutable(inspection, manifest.executable);
  const interfaceVerification = await verifyInterfaceAgainstNetwork(
    client,
    inspection,
    manifest.interface,
  );

  return buildDeploymentVerificationReport({
    manifest,
    inspection,
    networkCheck,
    executableVerification,
    interfaceVerification,
    manifestWarnings: options.manifestWarnings,
  });
}

/** Applies CLI/environment overrides on top of a loaded manifest document. */
function applyOverrides(raw: unknown, params: RunParams): unknown {
  if (!isRecord(raw)) return raw;

  const clone: Record<string, unknown> = { ...raw };

  if (params.contractId) clone.contractId = params.contractId;

  if (params.rpcUrl) {
    const network = isRecord(clone.network) ? { ...clone.network } : {};
    network.rpcUrl = params.rpcUrl;
    clone.network = network;
  }

  return clone;
}

function printManifestFailure(errors: string[], warnings: string[], jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'invalid_manifest', errors, warnings }, null, 2));
    return;
  }

  console.error(chalk.red('\nInvalid deployment manifest — no network request was made.'));
  for (const error of errors) console.error(chalk.red(`  - ${error}`));
  for (const warning of warnings) console.error(chalk.yellow(`  warning: ${warning}`));
}

export async function run(params: RunParams = {}): Promise<void> {
  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true';
  const environment = params.environment ?? process.env.MANIFEST_ENV ?? 'testnet';
  const manifestFile = params.manifestFile ?? process.env.MANIFEST_FILE;
  const overrideContractId = params.contractId ?? process.env.CONTRACT_ID;
  const overrideRpcUrl = params.rpcUrl ?? process.env.SOROBAN_RPC_URL;

  let rawManifest: unknown;
  try {
    if (manifestFile) {
      rawManifest = loadManifestFile(manifestFile);
    } else {
      rawManifest = SAMPLE_MANIFESTS[environment];
      if (!rawManifest) {
        throw new Error(
          `No sample manifest for environment "${environment}". ` +
            `Available: ${Object.keys(SAMPLE_MANIFESTS).join(', ')}. ` +
            'Set MANIFEST_FILE to audit your own deployment.',
        );
      }
    }
  } catch (error) {
    printManifestFailure([describeError(error)], [], jsonOutput);
    return;
  }

  const manifestInput = applyOverrides(rawManifest, {
    contractId: overrideContractId,
    rpcUrl: overrideRpcUrl,
    environment,
  });

  // Validate before any network access: a broken expectation must never be
  // reported as a broken deployment.
  const validation = validateManifest(manifestInput);
  if (!validation.valid || !validation.manifest) {
    printManifestFailure(validation.errors, validation.warnings, jsonOutput);
    return;
  }

  const manifest = validation.manifest;

  if (!jsonOutput) {
    console.log(chalk.bold.blue('\nSoroban Contract Deployment Verification'));
    console.log(chalk.gray('Read-only audit: no transaction is built, signed or submitted.'));
    console.log(chalk.gray(`Manifest environment: ${manifest.environment}`));
    console.log(chalk.gray(`Soroban RPC:          ${manifest.network.rpcUrl}`));
  }

  let report: DeploymentVerificationReport;
  try {
    const client = new rpc.Server(manifest.network.rpcUrl, {
      // Local Soroban RPC nodes are commonly served over plain HTTP.
      allowHttp: manifest.network.rpcUrl.startsWith('http://'),
    });
    report = await verifyDeployment(client, manifest, {
      manifestWarnings: validation.warnings,
    });
  } catch (error) {
    const message = `Deployment verification aborted: ${describeError(error)}`;
    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            environment: manifest.environment,
            contractId: manifest.contractId,
            network: manifest.network,
            overallStatus: 'inconclusive',
            error: message,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(chalk.red(`\n${message}`));
      console.error(
        chalk.yellow(
          'Check the RPC endpoint URL and network connectivity, then run the audit again.',
        ),
      );
    }
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log(formatDeploymentVerificationReport(report));
  console.log('');

  if (report.overallStatus === 'verified') {
    console.log(chalk.green('Deployment matches the manifest.'));
  } else if (report.overallStatus === 'failed') {
    console.log(chalk.red('Deployment does NOT match the manifest. Review the mismatches above.'));
  } else {
    console.log(
      chalk.yellow(
        'Deployment verification is INCONCLUSIVE — some checks could not be completed. ' +
          'Inconclusive is not a pass.',
      ),
    );
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
