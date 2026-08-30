import { readFileSync } from 'fs';
import path from 'path';

import * as ex82 from '../src/examples/82-transaction-time-bounds';
import { examples } from '../src/runner/catalog';

describe('ISSUE-082: Soroban Transaction Time Bounds', () => {
  const NOW = 1_800_000_000; // fixed reference "now" in Unix seconds

  describe('computeTimeBounds', () => {
    it('computes minTime and maxTime from an offset and a validity duration', () => {
      expect(ex82.computeTimeBounds(NOW, 0, 60)).toEqual({
        minTime: NOW,
        maxTime: NOW + 60,
      });
    });

    it('supports a positive minOffset (window opens later)', () => {
      expect(ex82.computeTimeBounds(NOW, 300, 120)).toEqual({
        minTime: NOW + 300,
        maxTime: NOW + 420,
      });
    });

    it('supports a negative minOffset (window already opened in the past)', () => {
      expect(ex82.computeTimeBounds(NOW, -3600, 1800)).toEqual({
        minTime: NOW - 3600,
        maxTime: NOW - 1800,
      });
    });
  });

  describe('validateTimeBounds', () => {
    it('does not throw for a well-formed window', () => {
      expect(() => ex82.validateTimeBounds(NOW, NOW + 60)).not.toThrow();
    });

    it('throws when maxTime is not greater than minTime, mentioning both values', () => {
      expect(() => ex82.validateTimeBounds(NOW, NOW)).toThrow(
        new RegExp(`maxTime \\(${NOW}\\).*minTime \\(${NOW}\\)`),
      );
      expect(() => ex82.validateTimeBounds(NOW + 100, NOW)).toThrow(/maxTime.*minTime/);
    });

    it('throws for negative timestamps', () => {
      expect(() => ex82.validateTimeBounds(-1, 100)).toThrow(/must not be negative/);
      expect(() => ex82.validateTimeBounds(0, -100)).toThrow(/must not be negative/);
    });

    it('throws for non-integer or NaN values', () => {
      expect(() => ex82.validateTimeBounds(NaN, 100)).toThrow(/integer/);
      expect(() => ex82.validateTimeBounds(0, NaN)).toThrow(/integer/);
      expect(() => ex82.validateTimeBounds(1.5, 100)).toThrow(/integer/);
    });
  });

  describe('isExpired', () => {
    it('returns true when now is past maxTime', () => {
      expect(ex82.isExpired(NOW - 1, NOW)).toBe(true);
    });

    it('returns false when now is before or at maxTime', () => {
      expect(ex82.isExpired(NOW + 1, NOW)).toBe(false);
      expect(ex82.isExpired(NOW, NOW)).toBe(false);
    });

    it('treats maxTime === 0 as "no upper bound" — never expired', () => {
      expect(ex82.isExpired(0, NOW)).toBe(false);
      expect(ex82.isExpired(0, Number.MAX_SAFE_INTEGER)).toBe(false);
    });
  });

  describe('isNotYetValid', () => {
    it('returns true before minTime', () => {
      expect(ex82.isNotYetValid(NOW + 10, NOW)).toBe(true);
    });

    it('returns false at or after minTime', () => {
      expect(ex82.isNotYetValid(NOW, NOW)).toBe(false);
      expect(ex82.isNotYetValid(NOW - 10, NOW)).toBe(false);
    });
  });

  describe('describeValidityWindow', () => {
    it('describes a currently valid window', () => {
      const description = ex82.describeValidityWindow(NOW - 10, NOW + 42, NOW);
      expect(description).toContain('Valid');
      expect(description).toContain('42');
    });

    it('describes a not-yet-valid window', () => {
      const description = ex82.describeValidityWindow(NOW + 5, NOW + 65, NOW);
      expect(description).toContain('Not yet valid');
      expect(description).toContain('5');
    });

    it('describes an expired window', () => {
      const description = ex82.describeValidityWindow(NOW - 3600, NOW - 1800, NOW);
      expect(description).toContain('Expired');
      expect(description).toContain(`${NOW - 1800}`);
    });
  });

  describe('explainTimeBoundsFailure', () => {
    it('recognizes tx_too_late', () => {
      const { guidance } = ex82.explainTimeBoundsFailure(
        'sendTransaction rejected with tx_too_late',
      );
      expect(guidance.length).toBeGreaterThan(0);
      expect(guidance.toLowerCase()).toContain('maxtime');
    });

    it('recognizes tx_too_early', () => {
      const { guidance } = ex82.explainTimeBoundsFailure(
        'sendTransaction rejected with tx_too_early',
      );
      expect(guidance.length).toBeGreaterThan(0);
      expect(guidance.toLowerCase()).toContain('mintime');
    });

    it('falls back to generic guidance for unrecognized messages', () => {
      const { guidance } = ex82.explainTimeBoundsFailure('some unrelated network hiccup');
      expect(guidance.length).toBeGreaterThan(0);
    });

    it('never throws, even for empty or unusual input', () => {
      expect(() => ex82.explainTimeBoundsFailure('')).not.toThrow();
      expect(() => ex82.explainTimeBoundsFailure(undefined as unknown as string)).not.toThrow();
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example with a run function', () => {
      const entry = examples['82-transaction-time-bounds'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
    });

    it('documents the example in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`82-transaction-time-bounds`');
      expect(readme).toContain('npm run run-example 82-transaction-time-bounds');
    });
  });
});
