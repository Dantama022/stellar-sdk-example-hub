/**
 * Toolchain capture. Records the versions actually installed so they can be
 * compared with what the provenance metadata says was used.
 *
 * Commands run through an injectable CommandRunner (no shell), so tests never
 * need rustc, git or the Stellar CLI.
 */

import { execFile } from 'node:child_process';

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ToolchainInfo {
  rustc?: string;
  cargo?: string;
  /** Stellar CLI (`stellar`), or the older `soroban` binary when that is what is installed. */
  buildTool?: string;
  /** Tools that could not be run, with the reason. */
  unavailable: Record<string, string>;
}

async function version(run: CommandRunner, command: string, args: string[], unavailable: Record<string, string>): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, args);
    return stdout.split('\n')[0].trim() || undefined;
  } catch (err) {
    unavailable[command] = (err as Error).message.split('\n')[0];
    return undefined;
  }
}

export async function captureToolchain(run: CommandRunner = defaultRunner): Promise<ToolchainInfo> {
  const unavailable: Record<string, string> = {};
  const rustc = await version(run, 'rustc', ['--version'], unavailable);
  const cargo = await version(run, 'cargo', ['--version'], unavailable);
  let buildTool = await version(run, 'stellar', ['--version'], unavailable);
  if (!buildTool) {
    buildTool = await version(run, 'soroban', ['--version'], unavailable);
    if (buildTool) delete unavailable.stellar;
  }
  return { rustc, cargo, buildTool, unavailable };
}

/** Commit of the working tree and whether it has uncommitted changes. */
export async function captureSource(repoDir: string, run: CommandRunner = defaultRunner): Promise<{ commit?: string; dirty?: boolean; error?: string }> {
  try {
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    const status = await run('git', ['status', '--porcelain'], { cwd: repoDir });
    return { commit: head.stdout.trim().toLowerCase(), dirty: status.stdout.trim().length > 0 };
  } catch (err) {
    return { error: (err as Error).message.split('\n')[0] };
  }
}

/** Compare a recorded tool string with the installed one. Whitespace and case are ignored. */
export function sameVersion(recorded: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(recorded) === norm(actual);
}
