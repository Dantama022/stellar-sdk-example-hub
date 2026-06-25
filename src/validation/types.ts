export type ExampleValidationStatus = 'passed' | 'failed' | 'skipped';

export interface DiscoveredExample {
  name: string;
  filePath: string;
  relativePath: string;
}

export interface ExampleExclusionRule {
  match: string;
  reason: string;
}

export interface ValidationConfig {
  examplesDir: string;
  exampleFilePattern: string;
  timeoutMs: number;
  exclusions: ExampleExclusionRule[];
}

export interface ExampleValidationResult {
  name: string;
  status: ExampleValidationStatus;
  durationMs: number;
  stdout: string;
  stderr: string;
  timestamp: string;
  errorMessage?: string;
  skipReason?: string;
}

export interface ValidationSummary {
  discovered: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
}

export interface ValidationRunResult {
  summary: ValidationSummary;
  results: ExampleValidationResult[];
  report: string;
}
