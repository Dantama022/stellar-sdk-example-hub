/**
 * Optional build step. Only documented Soroban build commands are executed:
 * the metadata's `buildCommand` is data from a file, so it is checked against
 * an allow-list and run without a shell. Anything else is refused.
 */

import path from 'node:path';
import { defaultRunner, type CommandRunner } from './toolchain';

const ALLOWED = [
  /^stellar contract build(?: --[a-z][a-z0-9-]*(?:[ =][A-Za-z0-9_./:-]+)?)*$/,
  /^soroban contract build(?: --[a-z][a-z0-9-]*(?:[ =][A-Za-z0-9_./:-]+)?)*$/,
  /^cargo build --target wasm32(?:v1-none|-unknown-unknown) --release(?: --[a-z][a-z0-9-]*(?:[ =][A-Za-z0-9_./:-]+)?)*$/,
];

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

export function isAllowedBuildCommand(command: string): boolean {
  return ALLOWED.some((re) => re.test(command.trim()));
}

/** Run the recorded build command in the contract project and return the expected artifact path. */
export async function buildContract(
  projectDir: string,
  buildCommand: string,
  artifactPath: string,
  run: CommandRunner = defaultRunner,
): Promise<string> {
  if (!isAllowedBuildCommand(buildCommand)) {
    throw new BuildError(`refusing to run "${buildCommand}": only documented Soroban build commands (stellar/soroban contract build, cargo build --target wasm32...) are allowed`);
  }
  const [command, ...args] = buildCommand.trim().split(/\s+/);
  try {
    await run(command, args, { cwd: projectDir });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim().split('\n').slice(-5).join('\n');
    throw new BuildError(`build failed: ${(err as Error).message.split('\n')[0]}${stderr ? `\n${stderr}` : ''}`);
  }
  return path.resolve(projectDir, artifactPath);
}
