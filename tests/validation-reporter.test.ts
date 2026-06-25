import { buildValidationSummary, renderValidationReport } from '../src/validation/reporter';
import { ExampleValidationResult } from '../src/validation/types';

describe('Validation reporter', () => {
  it('builds summary counts and renders failures/skips', () => {
    const results: ExampleValidationResult[] = [
      {
        name: '01-create-account',
        status: 'passed',
        durationMs: 50,
        stdout: 'ok',
        stderr: '',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        name: '02-payment',
        status: 'failed',
        durationMs: 25,
        stdout: '',
        stderr: 'network error',
        timestamp: '2026-01-01T00:00:01.000Z',
        errorMessage: 'Execution exited with code 1',
      },
      {
        name: '03-create-trustline',
        status: 'skipped',
        durationMs: 0,
        stdout: '',
        stderr: '',
        timestamp: '2026-01-01T00:00:02.000Z',
        skipReason: 'Requires live network',
      },
    ];

    const summary = buildValidationSummary(3, results, 100);
    const report = renderValidationReport(summary, results);

    expect(summary.discovered).toBe(3);
    expect(summary.executed).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);

    expect(report).toContain('Examples Discovered: 3');
    expect(report).toContain('Failure Summary:');
    expect(report).toContain('Skipped Examples:');
    expect(report).toContain('Validation Failed');
  });
});
