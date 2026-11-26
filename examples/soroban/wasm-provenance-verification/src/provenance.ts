/**
 * Build provenance metadata: what was built, from which source, with which
 * toolchain, and which checksum a trusted party says the result must have.
 *
 * Keep this file small and secret-free. It is meant to be reviewed and
 * committed (or signed) alongside a release.
 */

import { readFile } from 'node:fs/promises';

export interface ProvenanceMetadata {
  /** Repository the contract source lives in, e.g. https://github.com/org/repo */
  sourceRepository: string;
  /** Full 40-character commit hash the artifact was built from. */
  commit: string;
  /** Path of the contract project inside the repository. */
  contractPath: string;
  /** `rustc --version` output at build time, e.g. `rustc 1.84.0 (9fc6b4312 2025-01-07)`. */
  rustc: string;
  /** Build tool and version, e.g. `stellar 22.1.0`. */
  buildTool: string;
  /** Compilation target, e.g. `wasm32v1-none` or `wasm32-unknown-unknown`. */
  target: string;
  /** Exact build command used. Recorded for humans; only allow-listed commands are ever executed. */
  buildCommand: string;
  /** Path to the produced WASM, relative to the contract project. */
  artifactPath: string;
  /** SHA-256 (hex) the artifact is expected to have. Must come from a trusted source. */
  expectedSha256: string;
}

export class ProvenanceError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid provenance metadata: ${problems.join('; ')}`);
    this.name = 'ProvenanceError';
  }
}

const REQUIRED: Array<keyof ProvenanceMetadata> = [
  'sourceRepository',
  'commit',
  'contractPath',
  'rustc',
  'buildTool',
  'target',
  'buildCommand',
  'artifactPath',
  'expectedSha256',
];

const SECRET_LIKE_KEY = /secret|private|password|token|api[-_]?key|credential|seed|mnemonic/i;

export function normalizeSha256(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeSha256(value));
}

/** Validate untrusted JSON into ProvenanceMetadata, reporting every problem at once. */
export function parseProvenance(input: unknown): ProvenanceMetadata {
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProvenanceError(['metadata must be a JSON object']);
  }
  const record = input as Record<string, unknown>;

  for (const key of REQUIRED) {
    const v = record[key];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`missing or empty field "${key}"`);
  }
  for (const key of Object.keys(record)) {
    if (SECRET_LIKE_KEY.test(key)) problems.push(`field "${key}" looks like a credential; provenance metadata must not contain secrets`);
  }
  if (typeof record.commit === 'string' && record.commit.trim() !== '' && !/^[0-9a-f]{40}$/i.test(record.commit.trim())) {
    problems.push('"commit" must be a full 40-character hex commit hash');
  }
  if (typeof record.expectedSha256 === 'string' && record.expectedSha256.trim() !== '' && !isSha256(record.expectedSha256)) {
    problems.push('"expectedSha256" must be 64 hex characters (optionally prefixed with "sha256:")');
  }
  if (problems.length > 0) throw new ProvenanceError(problems);

  const text = (k: keyof ProvenanceMetadata) => (record[k] as string).trim();
  return {
    sourceRepository: text('sourceRepository'),
    commit: text('commit').toLowerCase(),
    contractPath: text('contractPath'),
    rustc: text('rustc'),
    buildTool: text('buildTool'),
    target: text('target'),
    buildCommand: text('buildCommand'),
    artifactPath: text('artifactPath'),
    expectedSha256: normalizeSha256(text('expectedSha256')),
  };
}

export async function loadProvenance(file: string): Promise<ProvenanceMetadata> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new ProvenanceError([`cannot read metadata file ${file}: ${(err as Error).message}`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ProvenanceError([`metadata file ${file} is not valid JSON: ${(err as Error).message}`]);
  }
  return parseProvenance(json);
}
