import { spawn, SpawnOptions } from 'child_process';

import { isExampleExcluded } from './config';
import { DiscoveredExample, ExampleValidationResult, ValidationConfig } from './types';

interface OutputStreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

export interface SpawnedProcessLike {
  stdout?: OutputStreamLike | null;
  stderr?: OutputStreamLike | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(
    event: 'close',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcessLike;

interface SubprocessResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

export interface ExecuteExamplesOptions {
  config: ValidationConfig;
  includeExcluded?: boolean;
  onlyExampleNames?: string[];
  spawnProcess?: SpawnProcess;
}

export async function executeExamples(
  examples: DiscoveredExample[],
  options: ExecuteExamplesOptions,
): Promise<ExampleValidationResult[]> {
  const selected = filterSelectedExamples(examples, options.onlyExampleNames);
  const results: ExampleValidationResult[] = [];

  for (const example of selected) {
    const exclusion = isExampleExcluded(example.name, options.config.exclusions);
    if (exclusion && !options.includeExcluded) {
      results.push({
        name: example.name,
        status: 'skipped',
        durationMs: 0,
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString(),
        skipReason: exclusion.reason,
      });
      continue;
    }

    const startedAt = Date.now();
    const execution = await runExampleInSubprocess(
      example.filePath,
      options.config.timeoutMs,
      options.spawnProcess,
    );
    const durationMs = Date.now() - startedAt;

    const errorMessage = buildErrorMessage(execution);
    results.push({
      name: example.name,
      status: errorMessage ? 'failed' : 'passed',
      durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      timestamp: new Date().toISOString(),
      errorMessage,
    });
  }

  return results;
}

export function runExampleInSubprocess(
  examplePath: string,
  timeoutMs: number,
  spawnProcess: SpawnProcess = defaultSpawn,
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const script = [
      '(async () => {',
      `  const mod = require(${JSON.stringify(examplePath)});`,
      "  if (typeof mod.run !== 'function') {",
      "    throw new Error('Example module must export an async run() function.');",
      '  }',
      '  await mod.run();',
      '})().catch((error) => {',
      '  const output = error instanceof Error ? (error.stack ?? error.message) : String(error);',
      '  console.error(output);',
      '  process.exit(1);',
      '});',
    ].join('\n');

    const child = spawnProcess(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | undefined;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', (error) => {
      spawnError = error;
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        timedOut,
        exitCode,
        signal,
        spawnError,
      });
    });
  });
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnedProcessLike {
  return spawn(command, [...args], options);
}

function filterSelectedExamples(
  examples: DiscoveredExample[],
  onlyExampleNames?: string[],
): DiscoveredExample[] {
  if (!onlyExampleNames || onlyExampleNames.length === 0) {
    return examples;
  }

  const includeSet = new Set(onlyExampleNames);
  return examples.filter((example) => includeSet.has(example.name));
}

function buildErrorMessage(result: SubprocessResult): string | undefined {
  if (result.spawnError) {
    return result.spawnError.message;
  }

  if (result.timedOut) {
    return 'Execution timed out';
  }

  if (result.exitCode !== 0) {
    if (result.signal) {
      return `Execution terminated by signal: ${result.signal}`;
    }
    return `Execution exited with code ${result.exitCode}`;
  }

  return undefined;
}
