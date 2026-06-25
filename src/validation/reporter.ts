import { ExampleValidationResult, ValidationSummary } from './types';

export function buildValidationSummary(
  discoveredCount: number,
  results: ExampleValidationResult[],
  totalDurationMs: number,
): ValidationSummary {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;

  return {
    discovered: discoveredCount,
    executed: passed + failed,
    passed,
    failed,
    skipped,
    totalDurationMs,
  };
}

export function renderValidationReport(
  summary: ValidationSummary,
  results: ExampleValidationResult[],
): string {
  const lines: string[] = [];
  lines.push(`Examples Discovered: ${summary.discovered}`);
  lines.push(`Total Executed: ${summary.executed}`);
  lines.push(`Passed: ${summary.passed}`);
  lines.push(`Failed: ${summary.failed}`);
  lines.push(`Skipped: ${summary.skipped}`);
  lines.push(`Execution Time: ${summary.totalDurationMs}ms`);

  const failures = results.filter((result) => result.status === 'failed');
  if (failures.length > 0) {
    lines.push('');
    lines.push('Failure Summary:');
    for (const failure of failures) {
      lines.push(`- ${failure.name} (${failure.durationMs}ms)`);
      if (failure.errorMessage) {
        lines.push(`  Error: ${failure.errorMessage}`);
      }
      if (failure.stderr.trim().length > 0) {
        lines.push(`  Stderr: ${trimForReport(failure.stderr)}`);
      }
      if (failure.stdout.trim().length > 0) {
        lines.push(`  Stdout: ${trimForReport(failure.stdout)}`);
      }
      lines.push(`  Timestamp: ${failure.timestamp}`);
    }
  }

  const skipped = results.filter((result) => result.status === 'skipped' && result.skipReason);
  if (skipped.length > 0) {
    lines.push('');
    lines.push('Skipped Examples:');
    for (const item of skipped) {
      lines.push(`- ${item.name}: ${item.skipReason}`);
    }
  }

  lines.push('');
  lines.push(summary.failed > 0 ? 'Validation Failed' : 'Validation Passed');

  return lines.join('\n');
}

function trimForReport(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}...` : collapsed;
}
