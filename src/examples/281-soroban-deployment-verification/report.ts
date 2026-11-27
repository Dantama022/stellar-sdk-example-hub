import type { ContractInstanceInspection } from './contract-inspector';
import type { ExecutableVerification } from './executable-verifier';
import type { InterfaceVerification } from './interface-verifier';
import type { DeploymentManifest } from './manifest';
import type { NetworkCheckResult } from './network-check';

export type OverallVerificationStatus = 'verified' | 'failed' | 'inconclusive';

export interface AvailabilitySummary {
  status: 'available' | 'not_found' | 'unavailable';
  latestLedger: number | null;
  lastModifiedLedgerSeq: number | null;
  liveUntilLedgerSeq: number | null;
  error: string | null;
}

export interface DeploymentVerificationReport {
  environment: string;
  contractId: string;
  network: { name: string; passphrase: string; rpcUrl: string };
  availability: AvailabilitySummary;
  networkCheck: NetworkCheckResult;
  executable: ExecutableVerification;
  interface: InterfaceVerification;
  /** Concrete inconsistencies that make the deployment fail verification. */
  mismatches: string[];
  /** Non-fatal observations, including skipped or partial checks. */
  warnings: string[];
  /** Checks that could not be completed: never treated as a pass. */
  inconclusiveChecks: string[];
  overallStatus: OverallVerificationStatus;
  metadata?: Record<string, string>;
}

export interface BuildReportInput {
  manifest: DeploymentManifest;
  inspection: ContractInstanceInspection;
  networkCheck: NetworkCheckResult;
  executableVerification: ExecutableVerification;
  interfaceVerification: InterfaceVerification;
  manifestWarnings?: string[];
}

/**
 * Aggregates the individual checks into one report.
 *
 * A mismatch always fails the verification. Otherwise any check that could not
 * be completed makes the result inconclusive rather than verified.
 */
export function determineOverallStatus(
  mismatches: string[],
  inconclusiveChecks: string[],
): OverallVerificationStatus {
  if (mismatches.length > 0) return 'failed';
  if (inconclusiveChecks.length > 0) return 'inconclusive';
  return 'verified';
}

export function buildDeploymentVerificationReport(
  input: BuildReportInput,
): DeploymentVerificationReport {
  const { manifest, inspection, networkCheck, executableVerification, interfaceVerification } =
    input;

  const mismatches: string[] = [];
  const warnings: string[] = [...(input.manifestWarnings ?? [])];
  const inconclusiveChecks: string[] = [];

  // --- Network configuration ------------------------------------------------
  if (networkCheck.status === 'mismatch') {
    mismatches.push(
      `Network passphrase mismatch: manifest expects "${networkCheck.expectedPassphrase}" ` +
        `but ${networkCheck.rpcUrl} reports "${networkCheck.reportedPassphrase}"`,
    );
  } else if (networkCheck.status === 'unavailable') {
    inconclusiveChecks.push(
      networkCheck.error ?? 'Network passphrase could not be verified against the RPC endpoint',
    );
  }

  // --- Availability ---------------------------------------------------------
  const availability: AvailabilitySummary = {
    status:
      inspection.status === 'found'
        ? 'available'
        : inspection.status === 'not_found'
          ? 'not_found'
          : 'unavailable',
    latestLedger: inspection.latestLedger,
    lastModifiedLedgerSeq: inspection.lastModifiedLedgerSeq,
    liveUntilLedgerSeq: inspection.liveUntilLedgerSeq,
    error: inspection.error,
  };

  if (inspection.status === 'not_found') {
    mismatches.push(
      inspection.error ??
        `Contract ${manifest.contractId} is not available on ${manifest.network.name}`,
    );
  } else if (inspection.status === 'error') {
    inconclusiveChecks.push(
      inspection.error ?? 'Contract instance could not be inspected on the selected network',
    );
  }

  if (
    inspection.liveUntilLedgerSeq !== null &&
    inspection.latestLedger !== null &&
    inspection.liveUntilLedgerSeq <= inspection.latestLedger
  ) {
    warnings.push(
      `Contract instance TTL has expired (liveUntilLedgerSeq ${inspection.liveUntilLedgerSeq} ` +
        `<= latest ledger ${inspection.latestLedger}); the entry may need restoration`,
    );
  }

  // --- Executable -----------------------------------------------------------
  if (executableVerification.status === 'mismatch') {
    mismatches.push(executableVerification.reason ?? 'Contract executable does not match manifest');
  }

  for (const note of executableVerification.notes) {
    if (executableVerification.status === 'inconclusive') {
      inconclusiveChecks.push(note);
    } else {
      warnings.push(note);
    }
  }

  // --- Interface ------------------------------------------------------------
  if (interfaceVerification.status === 'mismatch') {
    if (interfaceVerification.missingFunctions.length > 0) {
      mismatches.push(
        `Missing contract functions: ${interfaceVerification.missingFunctions.join(', ')}`,
      );
    }
    if (interfaceVerification.unexpectedFunctions.length > 0) {
      mismatches.push(
        `Unexpected contract functions: ${interfaceVerification.unexpectedFunctions.join(', ')}`,
      );
    }
    for (const signature of interfaceVerification.signatureMismatches) {
      mismatches.push(
        `Signature mismatch for "${signature.name}": expected ${signature.expected}, ` +
          `retrieved ${signature.actual}`,
      );
    }
  }

  if (interfaceVerification.status === 'unavailable') {
    const notes =
      interfaceVerification.notes.length > 0
        ? interfaceVerification.notes
        : ['Contract specification could not be retrieved'];
    inconclusiveChecks.push(...notes);
  } else {
    warnings.push(...interfaceVerification.notes);
  }

  const report: DeploymentVerificationReport = {
    environment: manifest.environment,
    contractId: manifest.contractId,
    network: { ...manifest.network },
    availability,
    networkCheck,
    executable: executableVerification,
    interface: interfaceVerification,
    mismatches,
    warnings,
    inconclusiveChecks,
    overallStatus: determineOverallStatus(mismatches, inconclusiveChecks),
  };

  if (manifest.metadata) report.metadata = manifest.metadata;

  return report;
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function nullable(value: string | number | null): string {
  return value === null ? 'n/a' : String(value);
}

function list(lines: string[], items: string[]): void {
  if (items.length === 0) {
    lines.push('  (none)');
    return;
  }
  for (const item of items) lines.push(`  - ${item}`);
}

/** Renders a report as plain text so it can be logged or diffed. */
export function formatDeploymentVerificationReport(report: DeploymentVerificationReport): string {
  const lines: string[] = [];

  lines.push('=== Soroban Deployment Verification Report ===');
  lines.push(`Environment:          ${report.environment}`);
  lines.push(`Contract address:     ${report.contractId}`);
  lines.push(`Network:              ${report.network.name} (${report.network.rpcUrl})`);
  lines.push(`Network passphrase:   ${report.network.passphrase}`);
  lines.push(`Verified passphrase:  ${report.networkCheck.status.toUpperCase()}`);
  if (report.networkCheck.reportedPassphrase !== null) {
    lines.push(`Reported passphrase:  ${report.networkCheck.reportedPassphrase}`);
  }
  lines.push(`Protocol version:     ${nullable(report.networkCheck.protocolVersion)}`);

  lines.push('');
  lines.push('--- Contract availability ---');
  lines.push(`Status:               ${report.availability.status}`);
  lines.push(`Latest ledger:        ${nullable(report.availability.latestLedger)}`);
  lines.push(`Instance modified at: ${nullable(report.availability.lastModifiedLedgerSeq)}`);
  lines.push(`Instance live until:  ${nullable(report.availability.liveUntilLedgerSeq)}`);
  if (report.availability.error) lines.push(`Detail:               ${report.availability.error}`);

  lines.push('');
  lines.push('--- Executable verification ---');
  lines.push(`Expected type:        ${report.executable.expectedType}`);
  lines.push(`Retrieved type:       ${nullable(report.executable.actualType)}`);
  lines.push(`Expected Wasm hash:   ${nullable(report.executable.expectedWasmHash)}`);
  lines.push(`Retrieved Wasm hash:  ${nullable(report.executable.retrievedWasmHash)}`);
  lines.push(`Result:               ${report.executable.status.toUpperCase()}`);
  if (report.executable.reason) lines.push(`Reason:               ${report.executable.reason}`);

  lines.push('');
  lines.push('--- Interface verification ---');
  lines.push(`Result:               ${report.interface.status.toUpperCase()}`);
  lines.push(
    `Specification:        ${
      report.interface.specificationAvailable ? 'available' : 'not retrieved'
    }`,
  );
  lines.push(`Expected functions:   ${report.interface.expectedFunctions.join(', ') || 'n/a'}`);
  lines.push(`Retrieved functions:  ${report.interface.actualFunctions.join(', ') || 'n/a'}`);
  lines.push(`Missing functions:    ${report.interface.missingFunctions.join(', ') || 'none'}`);
  lines.push(`Unexpected functions: ${report.interface.unexpectedFunctions.join(', ') || 'none'}`);

  lines.push('');
  lines.push('--- Configuration audit ---');
  lines.push('Mismatches:');
  list(lines, report.mismatches);
  lines.push('Warnings:');
  list(lines, report.warnings);
  lines.push('Inconclusive checks:');
  list(lines, report.inconclusiveChecks);

  lines.push('');
  lines.push(`Overall verification: ${report.overallStatus.toUpperCase()}`);
  if (report.metadata && Object.keys(report.metadata).length > 0) {
    lines.push('');
    lines.push('--- Manifest metadata (informational only) ---');
    for (const [key, value] of Object.entries(report.metadata)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return lines.join('\n');
}
