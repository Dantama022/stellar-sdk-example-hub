import { loadValidationConfig } from './config';
import { discoverExamples } from './discovery';
import { executeExamples, SpawnProcess } from './executor';
import { buildValidationSummary, renderValidationReport } from './reporter';
import { ValidationRunResult } from './types';

export interface ExampleValidationOptions {
  rootDir?: string;
  configPath?: string;
  includeExcluded?: boolean;
  onlyExampleNames?: string[];
  spawnProcess?: SpawnProcess;
}

export async function runExampleValidation(
  options: ExampleValidationOptions = {},
): Promise<ValidationRunResult> {
  const startedAt = Date.now();
  const config = await loadValidationConfig(options.rootDir, options.configPath);
  const discovered = await discoverExamples(config);
  const results = await executeExamples(discovered, {
    config,
    includeExcluded: options.includeExcluded,
    onlyExampleNames: options.onlyExampleNames,
    spawnProcess: options.spawnProcess,
  });

  const totalDurationMs = Date.now() - startedAt;
  const summary = buildValidationSummary(discovered.length, results, totalDurationMs);
  const report = renderValidationReport(summary, results);

  return { summary, results, report };
}
