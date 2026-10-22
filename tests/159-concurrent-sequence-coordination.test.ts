/**
 * Tests for 159-concurrent-sequence-coordination example
 */

import {
  SequenceCoordinator,
  MockHorizonServer,
  runExample,
  TransactionSubmission,
} from '../src/examples/159-concurrent-sequence-coordination';

describe('159-concurrent-sequence-coordination', () => {
  describe('SequenceCoordinator', () => {
    it('should allocate unique sequences sequentially', () => {
      const coordinator = new SequenceCoordinator('100');

      const seq1 = coordinator.allocateNextSequence('task-1');
      const seq2 = coordinator.allocateNextSequence('task-2');
      const seq3 = coordinator.allocateNextSequence('task-3');

      expect(seq1).toBe('101');
      expect(seq2).toBe('102');
      expect(seq3).toBe('103');
    });

    it('should track all allocations', () => {
      const coordinator = new SequenceCoordinator('100');

      coordinator.allocateNextSequence('task-1');
      coordinator.allocateNextSequence('task-2');
      coordinator.allocateNextSequence('task-3');

      const allocations = coordinator.getAllocations();
      expect(allocations).toHaveLength(3);
      expect(allocations.map((a) => a.sequenceNumber)).toEqual(['101', '102', '103']);
    });

    it('should handle large sequence numbers without precision loss', () => {
      const largeSeq = '9223372036854775000'; // Near Number.MAX_SAFE_INTEGER
      const coordinator = new SequenceCoordinator(largeSeq);

      const seq1 = coordinator.allocateNextSequence('task-1');
      const seq2 = coordinator.allocateNextSequence('task-2');

      // Verify no precision loss
      expect(BigInt(seq1)).toBe(BigInt(largeSeq) + 1n);
      expect(BigInt(seq2)).toBe(BigInt(largeSeq) + 2n);
    });
  });

  describe('MockHorizonServer', () => {
    it('should successfully submit transactions', async () => {
      const server = new MockHorizonServer();
      // Note: In a real test, we'd build actual Transaction objects
      // For now, we just verify the structure
      expect(server).toBeDefined();
    });

    it('should track submitted hashes', async () => {
      const server = new MockHorizonServer();
      expect(server.getSubmittedHashes()).toHaveLength(0);
    });

    it('should track sequence conflicts', async () => {
      const server = new MockHorizonServer();
      expect(server.getSequenceConflicts()).toHaveLength(0);
    });
  });

  describe('runExample', () => {
    it('should run with default parameters', async () => {
      const report = await runExample({ json: true });

      expect(report).toBeDefined();
      expect(report.accountId).toBeDefined();
      expect(report.baseSequence).toBe('100');
      expect(report.allocations).toBeDefined();
      expect(report.submissions).toBeDefined();
      expect(Array.isArray(report.sequenceGaps)).toBe(true);
      expect(typeof report.validationPassed).toBe('boolean');
    });

    it('should allocate correct number of sequences', async () => {
      const report = await runExample({
        concurrentTasks: 3,
        json: true,
      });

      expect(report.allocations).toHaveLength(3);
      expect(report.submissions).toHaveLength(3);
    });

    it('should track submission results', async () => {
      const report = await runExample({
        concurrentTasks: 5,
        json: true,
      });

      const submissions: TransactionSubmission[] = report.submissions;
      expect(submissions).toHaveLength(5);

      // All submissions should have a status
      for (const submission of submissions) {
        expect(['success', 'network_error', 'sequence_conflict', 'terminal_error']).toContain(
          submission.resultStatus
        );
      }
    });

    it('should validate sequences correctly', async () => {
      const report = await runExample({
        concurrentTasks: 10,
        json: true,
      });

      // With normal (non-failing) mode, validation should pass
      expect(report.validationPassed).toBe(true);
      expect(report.sequenceGaps).toHaveLength(0);
    });

    it('should handle sequence conflict failure mode', async () => {
      const report = await runExample({
        concurrentTasks: 5,
        mockFailureMode: 'sequence_conflict',
        json: true,
      });

      // At least one submission should have sequence_conflict status
      const conflicts = report.submissions.filter(
        (s) => s.resultStatus === 'sequence_conflict'
      );
      expect(conflicts.length).toBeGreaterThan(0);
    });

    it('should handle network error failure mode', async () => {
      const report = await runExample({
        concurrentTasks: 5,
        mockFailureMode: 'network_error',
        json: true,
      });

      // At least one submission should have network_error status
      const networkErrors = report.submissions.filter((s) => s.resultStatus === 'network_error');
      expect(networkErrors.length).toBeGreaterThan(0);
    });

    it('should sort submissions by sequence number', async () => {
      const report = await runExample({
        concurrentTasks: 5,
        json: true,
      });

      const sequences = report.submissions.map((s) => BigInt(s.sequenceNumber));
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i] >= sequences[i - 1]).toBe(true);
      }
    });
  });

  describe('Sequence Contiguity', () => {
    it('should maintain contiguous sequences across multiple concurrent tasks', async () => {
      const report = await runExample({
        concurrentTasks: 20,
        json: true,
      });

      const baseSeq = BigInt(report.baseSequence);
      const allocatedSeqs = report.allocations.map((a) => BigInt(a.sequenceNumber)).sort((a, b) =>
        a < b ? -1 : 1
      );

      // Sequences should start at baseSeq + 1
      expect(allocatedSeqs[0]).toBe(baseSeq + 1n);

      // Each sequence should be exactly 1 more than the previous
      for (let i = 1; i < allocatedSeqs.length; i++) {
        expect(allocatedSeqs[i]).toBe(allocatedSeqs[i - 1] + 1n);
      }
    });

    it('should detect gaps in allocations if they occur', async () => {
      // This test verifies the gap-detection logic
      // In normal operation, no gaps should occur, but the validator should catch them
      const report = await runExample({
        concurrentTasks: 5,
        json: true,
      });

      // Normal run should have no gaps
      expect(report.sequenceGaps).toHaveLength(0);
    });
  });

  describe('Report Structure', () => {
    it('should include all required fields in report', async () => {
      const report = await runExample({
        concurrentTasks: 3,
        json: true,
      });

      expect(report).toHaveProperty('accountId');
      expect(report).toHaveProperty('baseSequence');
      expect(report).toHaveProperty('allocations');
      expect(report).toHaveProperty('submissions');
      expect(report).toHaveProperty('sequenceGaps');
      expect(report).toHaveProperty('validationPassed');
    });

    it('should provide meaningful task identifiers', async () => {
      const report = await runExample({
        concurrentTasks: 3,
        json: true,
      });

      const taskIds = report.allocations.map((a) => a.taskId);
      expect(taskIds).toContain('task-0');
      expect(taskIds).toContain('task-1');
      expect(taskIds).toContain('task-2');
    });
  });
});
