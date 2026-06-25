import fs from 'fs/promises';
import path from 'path';

import { ExampleExclusionRule, ValidationConfig } from './types';

interface ValidationConfigFile {
  examplesDir?: string;
  exampleFilePattern?: string;
  timeoutMs?: number;
  exclusions?: ExampleExclusionRule[];
}

const DEFAULT_CONFIG_PATH = path.join('src', 'validation', 'validation.config.json');
const DEFAULT_EXAMPLES_DIR = path.join('src', 'examples');
const DEFAULT_EXAMPLE_PATTERN = '^\\d{2}-.+\\.ts$';
const DEFAULT_TIMEOUT_MS = 120_000;

export async function loadValidationConfig(
  rootDir: string = process.cwd(),
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<ValidationConfig> {
  const resolvedConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(rootDir, configPath);

  const raw = await fs.readFile(resolvedConfigPath, 'utf8');
  const parsed: ValidationConfigFile = JSON.parse(raw) as ValidationConfigFile;

  const examplesDir = parsed.examplesDir ?? DEFAULT_EXAMPLES_DIR;
  const resolvedExamplesDir = path.isAbsolute(examplesDir)
    ? examplesDir
    : path.join(rootDir, examplesDir);

  return {
    examplesDir: resolvedExamplesDir,
    exampleFilePattern: parsed.exampleFilePattern ?? DEFAULT_EXAMPLE_PATTERN,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    exclusions: parsed.exclusions ?? [],
  };
}

export function isExampleExcluded(
  exampleName: string,
  exclusions: ExampleExclusionRule[],
): ExampleExclusionRule | undefined {
  return exclusions.find((rule) => wildcardToRegExp(rule.match).test(exampleName));
}

function wildcardToRegExp(value: string): RegExp {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
