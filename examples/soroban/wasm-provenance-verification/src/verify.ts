/**
 * WASM artifact verification.
 *
 *   npx ts-node src/verify.ts --metadata provenance.json [--artifact path.wasm]
 *        [--build] [--contract-id C... --rpc-url https://...] [--json]
 *
 * Exit codes: 0 verified, 1 verification failed (mismatch), 2 could not verify
 * (usage error, malformed metadata, missing artifact, build failure).
 *
 * What a pass means: the artifact is byte-identical to the one the trusted
 * expected checksum describes. It does not prove the source is safe, and it
 * proves nothing about who produced the checksum: that trust comes from where
 * you obtained it (a reviewed release, a signed build record), never from a
 * file sitting next to the artifact.
 */

import path from 'node:path';
import { rpc } from '@stellar/stellar-sdk';
import { BuildError, buildContract } from './build';
import { compareWithDeployed, fetchDeployedExecutable, type DeployedComparison, type LedgerEntryReader } from './deployed';
import { ArtifactError, sha256File } from './hash';
import { ProvenanceError, loadProvenance, normalizeSha256, isSha256, type ProvenanceMetadata } from './provenance';
import { captureSource, captureToolchain, defaultRunner, sameVersion, type CommandRunner, type ToolchainInfo } from './toolchain';

export interface VerifyOptions {
  metadata: ProvenanceMetadata;
  /** Directory metadata paths are relative to. Defaults to the current directory. */
  baseDir?: string;
  /** Overrides metadata.artifactPath. */
  artifactPath?: string;
  /** Trusted checksum from outside the artifact's directory; overrides metadata.expectedSha256. */
  expectedSha256?: string;
  /** Run the (allow-listed) build command first. */
  build?: boolean;
  contractId?: string;
  /** RPC access for the deployed comparison. Omit to skip it. */
  server?: LedgerEntryReader;
  runner?: CommandRunner;
}

export type IntegrityStatus = 'match' | 'mismatch' | 'artifact-missing' | 'artifact-error' | 'build-failed';

export interface VerificationReport {
  sourceRevision: { recorded: string; actual?: string; dirty?: boolean; matchesRecorded?: boolean };
  toolchain: {
    recorded: { rustc: string; buildTool: string; target: string; buildCommand: string };
    installed: ToolchainInfo;
    differences: string[];
  };
  artifact: { path: string; sha256?: string; error?: string };
  expectedSha256: string;
  integrity: IntegrityStatus;
  deployed: DeployedComparison;
  verified: boolean;
  exitCode: 0 | 1 | 2;
  warnings: string[];
  /** What this result does and does not establish. */
  statement: string;
}

const STATEMENT =
  'A match proves byte-level equality between this artifact and the checksum you supplied. It does not prove the source code is safe, and it is only as trustworthy as the source of the expected checksum (a reviewed release or signed build record, not a file stored beside the artifact).';

export async function verifyArtifact(options: VerifyOptions): Promise<VerificationReport> {
  const { metadata } = options;
  const run = options.runner ?? defaultRunner;
  const baseDir = options.baseDir ?? process.cwd();
  const projectDir = path.resolve(baseDir, metadata.contractPath);
  const warnings: string[] = [];

  const expected = normalizeSha256(options.expectedSha256 ?? metadata.expectedSha256);
  if (options.expectedSha256 !== undefined && !isSha256(options.expectedSha256)) {
    throw new ProvenanceError(['the supplied expected checksum must be 64 hex characters']);
  }

  const installed = await captureToolchain(run);
  const differences: string[] = [];
  const compare = (label: string, recorded: string, actual: string | undefined) => {
    if (!actual) differences.push(`${label}: not installed here (recorded "${recorded}")`);
    else if (!sameVersion(recorded, actual)) differences.push(`${label}: recorded "${recorded}" but installed "${actual}"`);
  };
  compare('rustc', metadata.rustc, installed.rustc);
  compare('build tool', metadata.buildTool, installed.buildTool);
  if (differences.length > 0) warnings.push('Toolchain differs from the recorded one; a rebuild may legitimately produce different bytes.');

  const source = await captureSource(projectDir, run);
  const sourceRevision: VerificationReport['sourceRevision'] = {
    recorded: metadata.commit,
    actual: source.commit,
    dirty: source.dirty,
    matchesRecorded: source.commit ? source.commit === metadata.commit : undefined,
  };
  if (source.error) warnings.push(`Could not read the source revision (${source.error}); the recorded commit was not checked.`);
  else if (sourceRevision.matchesRecorded === false) warnings.push(`Working tree is at ${source.commit}, not the recorded commit ${metadata.commit}.`);
  if (source.dirty) warnings.push('Working tree has uncommitted changes; the artifact may not correspond to the recorded commit.');

  // An explicit --artifact is relative to the working directory; the metadata path is relative to the project.
  let artifactPath = options.artifactPath ? path.resolve(options.artifactPath) : path.resolve(projectDir, metadata.artifactPath);
  const artifact: VerificationReport['artifact'] = { path: artifactPath };
  let integrity: IntegrityStatus;

  try {
    if (options.build) artifactPath = await buildContract(projectDir, metadata.buildCommand, options.artifactPath ?? metadata.artifactPath, run);
    artifact.path = artifactPath;
    artifact.sha256 = await sha256File(artifactPath);
    integrity = artifact.sha256 === expected ? 'match' : 'mismatch';
  } catch (err) {
    artifact.error = (err as Error).message;
    integrity = err instanceof BuildError ? 'build-failed' : err instanceof ArtifactError && err.code === 'MISSING' ? 'artifact-missing' : 'artifact-error';
  }

  let deployed: DeployedComparison = { status: 'skipped', reason: 'no contract address and RPC server were provided' };
  if (options.contractId && options.server && artifact.sha256) {
    deployed = compareWithDeployed(artifact.sha256, options.contractId, await fetchDeployedExecutable(options.server, options.contractId));
  } else if (options.contractId && !options.server) {
    deployed = { status: 'skipped', reason: 'a contract address was given but no RPC server; pass --rpc-url' };
  } else if (!artifact.sha256 && options.contractId) {
    deployed = { status: 'skipped', reason: 'no local artifact checksum to compare' };
  }

  // Deployed comparison is only decisive when it was actually performed.
  const deployedOk = deployed.status === 'skipped' || deployed.status === 'match';
  const deployedFailed = deployed.status === 'mismatch';
  if (deployed.status === 'not-comparable' || deployed.status === 'not-found' || deployed.status === 'unavailable') {
    warnings.push(`Deployed comparison inconclusive: ${deployed.reason}`);
  }

  const verified = integrity === 'match' && deployedOk;
  const exitCode: VerificationReport['exitCode'] = verified ? 0 : integrity === 'mismatch' || deployedFailed ? 1 : 2;

  return {
    sourceRevision,
    toolchain: {
      recorded: { rustc: metadata.rustc, buildTool: metadata.buildTool, target: metadata.target, buildCommand: metadata.buildCommand },
      installed,
      differences,
    },
    artifact,
    expectedSha256: expected,
    integrity,
    deployed,
    verified,
    exitCode,
    warnings,
    statement: STATEMENT,
  };
}

export function formatReport(r: VerificationReport): string {
  const lines = [
    `Source revision:   recorded ${r.sourceRevision.recorded}${r.sourceRevision.actual ? `, working tree ${r.sourceRevision.actual}${r.sourceRevision.dirty ? ' (dirty)' : ''}` : ''}`,
    `Toolchain:         ${r.toolchain.recorded.rustc} / ${r.toolchain.recorded.buildTool} / ${r.toolchain.recorded.target}`,
    `  installed:       ${r.toolchain.installed.rustc ?? 'rustc unavailable'} / ${r.toolchain.installed.buildTool ?? 'build tool unavailable'}`,
    `Artifact:          ${r.artifact.path}`,
    `Local checksum:    ${r.artifact.sha256 ?? `(none) ${r.artifact.error ?? ''}`.trim()}`,
    `Expected checksum: ${r.expectedSha256}`,
    `Integrity:         ${r.integrity.toUpperCase()}`,
  ];
  if (r.deployed.status === 'match' || r.deployed.status === 'mismatch') {
    lines.push(`Deployed hash:     ${r.deployed.deployedWasmHash} (contract ${r.deployed.contractId})`);
  }
  lines.push(`Deployed compare:  ${r.deployed.status}${'reason' in r.deployed ? ` (${r.deployed.reason})` : ''}`);
  lines.push(`Result:            ${r.verified ? 'VERIFIED' : 'NOT VERIFIED'}`);
  for (const d of r.toolchain.differences) lines.push(`warning: ${d}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  lines.push('', r.statement);
  return lines.join('\n');
}

interface CliArgs {
  metadata?: string;
  artifact?: string;
  expected?: string;
  contractId?: string;
  rpcUrl?: string;
  build: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { build: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--metadata') args.metadata = next();
    else if (a === '--artifact') args.artifact = next();
    else if (a === '--expected-sha256') args.expected = next();
    else if (a === '--contract-id') args.contractId = next();
    else if (a === '--rpc-url') args.rpcUrl = next();
    else if (a === '--build') args.build = true;
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
    if (!args.metadata) throw new Error('--metadata <file> is required');
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: verify --metadata <file> [--artifact <wasm>] [--expected-sha256 <hex>] [--build] [--contract-id <C...> --rpc-url <url>] [--json]`);
    return 2;
  }
  try {
    const metadata = await loadProvenance(args.metadata);
    const server = args.rpcUrl ? new rpc.Server(args.rpcUrl, { allowHttp: args.rpcUrl.startsWith('http://') }) : undefined;
    const report = await verifyArtifact({
      metadata,
      baseDir: path.dirname(path.resolve(args.metadata)),
      artifactPath: args.artifact,
      expectedSha256: args.expected,
      build: args.build,
      contractId: args.contractId,
      server,
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.exitCode;
  } catch (err) {
    console.error(err instanceof ProvenanceError ? err.message : `verification could not run: ${(err as Error).message}`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
