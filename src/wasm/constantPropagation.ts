/**
 * WASM constant propagation analysis (ISSUE-268).
 *
 * Compiled WebAssembly regularly contains values that can be determined
 * statically: integer literals, constant-derived local values, comparisons
 * with a fixed outcome and branch conditions that are known before the
 * contract runs. This module reports those values so that compiler output
 * can be inspected without executing it.
 *
 * The analysis is deliberately conservative. A value is only reported as
 * constant when *every* operand is known; conflicting values at control-flow
 * merge points are represented as unknown instead of picking one of them, and
 * the fix-point iteration is bounded so loops always terminate.
 *
 * Nothing is executed: all values are derived by evaluating operator tables.
 */

import { readFileSync } from 'fs';
import { analyzeModuleFunctions } from './moduleAnalysis';
import {
  parseWasmModule,
  WasmParseError,
  type WasmInstruction,
  type WasmModule,
} from './wasmBinary';
import type { ConstantFinding } from './constantEngine';

/** A normalized constant finding. */
export interface ConstantRecord {
  /** Kind of the finding. */
  type:
    'constant' | 'derived' | 'propagated-local' | 'local-read' | 'comparison' | 'branch-condition';
  /** Index of the function in the module function index space. */
  functionIndex: number;
  /** Display name of the function. */
  functionName: string;
  /** Index of the basic block. */
  blockIndex: number;
  /** Index of the instruction inside the function. */
  instructionIndex: number;
  /** Mnemonic of the instruction. */
  opcode: string;
  /** Decimal representation of the constant, when there is one. */
  value?: string;
  /** Value type of the constant. */
  valueType?: 'i32' | 'i64';
  /** Propagation depth of the constant. */
  depth?: number;
  /** Additional detail, e.g. `always_true` or `always_false`. */
  detail?: string;
}

/** A merge point where the incoming values disagreed. */
export interface ConstantMerge {
  functionIndex: number;
  functionName: string;
  blockIndex: number;
  /** Locals whose incoming values disagreed. */
  locals: number[];
}

/** Aggregate counters of a constant propagation report. */
export interface ConstantTotals {
  /** Number of functions in the module. */
  totalFunctions: number;
  /** Number of functions that contain at least one constant. */
  functionsWithConstants: number;
  /** Number of instructions that produce a literal constant. */
  constantProducingInstructions: number;
  /** Number of arithmetic or bitwise results that were evaluated statically. */
  derivedValues: number;
  /** Number of values that were propagated into a local. */
  propagatedValues: number;
  /** Number of local reads that returned a known constant. */
  constantLocalReads: number;
  /** Number of comparisons that were resolved statically. */
  resolvedComparisons: number;
  /** Number of branch conditions that were resolved statically. */
  constantBranchConditions: number;
  /** Number of merge points with conflicting incoming values. */
  unknownValueMerges: number;
  /** Deepest constant derivation chain found in the module. */
  maxPropagationDepth: number;
  /** Number of branch conditions that are always taken. */
  alwaysTrueBranches: number;
  /** Number of branch conditions that are never taken. */
  alwaysFalseBranches: number;
}

/** The complete constant propagation report. */
export interface ConstantPropagationReport {
  /** Path of the analyzed artifact. */
  file: string;
  /** Normalized findings, ordered by function and instruction. */
  findings: ConstantRecord[];
  /** Merge points with conflicting incoming values. */
  merges: ConstantMerge[];
  /** Aggregate counters. */
  totals: ConstantTotals;
  /** Functions with the highest number of propagated constants. */
  topFunctionsByConstantCount: {
    functionIndex: number;
    functionName: string;
    count: number;
  }[];
  /** Opportunities to simplify control flow that is decided by constants. */
  simplificationOpportunities: {
    functionIndex: number;
    functionName: string;
    blockIndex: number;
    instructionIndex: number;
    opcode: string;
    detail: string;
  }[];
}

/** Converts an engine finding into a normalized record. */
function toRecord(finding: ConstantFinding): ConstantRecord {
  return {
    type: finding.type,
    functionIndex: finding.functionIndex,
    functionName: finding.functionName,
    blockIndex: finding.blockIndex,
    instructionIndex: finding.instructionIndex,
    opcode: finding.opcode,
    value: finding.value,
    valueType: finding.valueType,
    depth: finding.depth,
    detail: finding.detail,
  };
}

/** Analyzes the constant propagation of a decoded module. */
export function analyzeConstantPropagation(
  module: WasmModule,
  file = 'contract.wasm',
): ConstantPropagationReport {
  const analyzed = analyzeModuleFunctions(module);

  const findings: ConstantRecord[] = [];
  const merges: ConstantMerge[] = [];
  const perFunctionCounts = new Map<number, number>();

  for (const entry of analyzed) {
    for (const finding of entry.constants.findings) {
      findings.push(toRecord(finding));
    }
    for (const merge of entry.constants.merges) {
      merges.push({
        functionIndex: merge.functionIndex,
        functionName: merge.functionName,
        blockIndex: merge.blockIndex,
        locals: merge.locals,
      });
    }
    const count = entry.constants.findings.filter(
      (finding) => finding.type === 'propagated-local',
    ).length;
    perFunctionCounts.set(entry.func.index, count);
  }

  findings.sort((a, b) =>
    a.functionIndex === b.functionIndex
      ? a.instructionIndex - b.instructionIndex
      : a.functionIndex - b.functionIndex,
  );
  merges.sort((a, b) =>
    a.functionIndex === b.functionIndex
      ? a.blockIndex - b.blockIndex
      : a.functionIndex - b.functionIndex,
  );

  const branchConditions = findings.filter((finding) => finding.type === 'branch-condition');
  const depths = findings.map((finding) => finding.depth ?? 0).filter((depth) => depth > 0);

  const totals: ConstantTotals = {
    totalFunctions: analyzed.length,
    functionsWithConstants: new Set(findings.map((finding) => finding.functionIndex)).size,
    constantProducingInstructions: findings.filter((finding) => finding.type === 'constant').length,
    derivedValues: findings.filter((finding) => finding.type === 'derived').length,
    propagatedValues: findings.filter((finding) => finding.type === 'propagated-local').length,
    constantLocalReads: findings.filter((finding) => finding.type === 'local-read').length,
    resolvedComparisons: findings.filter((finding) => finding.type === 'comparison').length,
    constantBranchConditions: branchConditions.length,
    unknownValueMerges: merges.length,
    maxPropagationDepth: depths.length > 0 ? Math.max(...depths) : 0,
    alwaysTrueBranches: branchConditions.filter((finding) => finding.detail === 'always_true')
      .length,
    alwaysFalseBranches: branchConditions.filter((finding) => finding.detail === 'always_false')
      .length,
  };

  const topFunctionsByConstantCount = analyzed
    .map((entry) => ({
      functionIndex: entry.func.index,
      functionName: entry.func.name ?? `func_${entry.func.index}`,
      count: perFunctionCounts.get(entry.func.index) ?? 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => (b.count === a.count ? a.functionIndex - b.functionIndex : b.count - a.count));

  const simplificationOpportunities = branchConditions.map((finding) => ({
    functionIndex: finding.functionIndex,
    functionName: finding.functionName,
    blockIndex: finding.blockIndex,
    instructionIndex: finding.instructionIndex,
    opcode: finding.opcode,
    detail:
      finding.detail === 'always_true'
        ? 'the branch is always taken and can be replaced with an unconditional branch'
        : 'the branch is never taken and can be removed',
  }));

  return {
    file,
    findings,
    merges,
    totals,
    topFunctionsByConstantCount,
    simplificationOpportunities,
  };
}

/** Analyzes the constant propagation of a `.wasm` file. */
export function analyzeConstantPropagationFile(file: string): ConstantPropagationReport {
  const buffer = readFileSync(file);
  const module = parseWasmModule(buffer);
  return analyzeConstantPropagation(module, file);
}

/** A single change between two constant inventories. */
export interface ConstantChange {
  key: string;
  functionIndex: number;
  functionName: string;
  oldValue?: string;
  newValue?: string;
  oldDetail?: string;
  newDetail?: string;
}

/** The result of comparing the constants of two artifacts. */
export interface ConstantComparison {
  oldFile: string;
  newFile: string;
  /** Constants that only exist in the new artifact. */
  newlyPropagated: ConstantRecord[];
  /** Constants that only exist in the old artifact. */
  removedPropagated: ConstantRecord[];
  /** Constants whose value changed. */
  changedValues: ConstantChange[];
  /** Branch conditions that became statically resolvable. */
  newlyConstantBranches: ConstantRecord[];
  /** Branch conditions that are no longer statically resolvable. */
  unresolvableBranches: ConstantRecord[];
  /** Summary counters. */
  summary: {
    oldFindingCount: number;
    newFindingCount: number;
    newlyPropagated: number;
    removedPropagated: number;
    changedValues: number;
    newlyConstantBranches: number;
    unresolvableBranches: number;
  };
}

/** Stable key of a constant finding. */
export function constantKey(record: ConstantRecord): string {
  return `${record.functionIndex}#${record.instructionIndex}#${record.type}`;
}

/** Compares the constants of two artifacts. */
export function compareConstantPropagation(
  oldReport: ConstantPropagationReport,
  newReport: ConstantPropagationReport,
): ConstantComparison {
  const oldByKey = new Map(oldReport.findings.map((finding) => [constantKey(finding), finding]));
  const newByKey = new Map(newReport.findings.map((finding) => [constantKey(finding), finding]));
  const keys = Array.from(new Set([...oldByKey.keys(), ...newByKey.keys()])).sort();

  const newlyPropagated: ConstantRecord[] = [];
  const removedPropagated: ConstantRecord[] = [];
  const changedValues: ConstantChange[] = [];
  const newlyConstantBranches: ConstantRecord[] = [];
  const unresolvableBranches: ConstantRecord[] = [];

  for (const key of keys) {
    const oldFinding = oldByKey.get(key);
    const newFinding = newByKey.get(key);

    if (oldFinding && !newFinding) {
      if (oldFinding.type === 'propagated-local') removedPropagated.push(oldFinding);
      if (oldFinding.type === 'branch-condition') unresolvableBranches.push(oldFinding);
      continue;
    }
    if (!oldFinding && newFinding) {
      if (newFinding.type === 'propagated-local') newlyPropagated.push(newFinding);
      if (newFinding.type === 'branch-condition') newlyConstantBranches.push(newFinding);
      continue;
    }

    const oldEntry = oldFinding as ConstantRecord;
    const newEntry = newFinding as ConstantRecord;

    if (oldEntry.value !== newEntry.value) {
      changedValues.push({
        key,
        functionIndex: oldEntry.functionIndex,
        functionName: oldEntry.functionName,
        oldValue: oldEntry.value,
        newValue: newEntry.value,
      });
    }
    if (oldEntry.type === 'branch-condition' && newEntry.type !== 'branch-condition') {
      unresolvableBranches.push(oldEntry);
    }
  }

  return {
    oldFile: oldReport.file,
    newFile: newReport.file,
    newlyPropagated,
    removedPropagated,
    changedValues,
    newlyConstantBranches,
    unresolvableBranches,
    summary: {
      oldFindingCount: oldReport.findings.length,
      newFindingCount: newReport.findings.length,
      newlyPropagated: newlyPropagated.length,
      removedPropagated: removedPropagated.length,
      changedValues: changedValues.length,
      newlyConstantBranches: newlyConstantBranches.length,
      unresolvableBranches: unresolvableBranches.length,
    },
  };
}

/** Renders a human-readable constant propagation report. */
export function formatConstantPropagationReport(report: ConstantPropagationReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push('WASM constant propagation analysis');
  lines.push('=================================');
  lines.push(`Artifact: ${report.file}`);
  lines.push('');
  lines.push('Summary');
  lines.push('-------');
  lines.push(`Functions:                     ${totals.totalFunctions}`);
  lines.push(`Functions with constants:       ${totals.functionsWithConstants}`);
  lines.push(`Constant-producing instructions: ${totals.constantProducingInstructions}`);
  lines.push(`Statically derived values:       ${totals.derivedValues}`);
  lines.push(`Propagated values:              ${totals.propagatedValues}`);
  lines.push(`Constant local reads:           ${totals.constantLocalReads}`);
  lines.push(`Resolved comparisons:           ${totals.resolvedComparisons}`);
  lines.push(`Constant branch conditions:     ${totals.constantBranchConditions}`);
  lines.push(`  always true:                  ${totals.alwaysTrueBranches}`);
  lines.push(`  always false:                 ${totals.alwaysFalseBranches}`);
  lines.push(`Unknown-value merges:           ${totals.unknownValueMerges}`);
  lines.push(`Maximum propagation depth:      ${totals.maxPropagationDepth}`);
  lines.push('');

  lines.push('Findings');
  lines.push('--------');
  if (report.findings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const finding of report.findings) {
      const value = finding.value !== undefined ? ` = ${finding.value}` : '';
      const detail = finding.detail ? ` (${finding.detail})` : '';
      lines.push(
        `  [fn ${finding.functionIndex}] block ${finding.blockIndex} ` +
          `instr ${finding.instructionIndex}: ${finding.opcode}${value}${detail}`,
      );
    }
  }

  if (report.merges.length > 0) {
    lines.push('');
    lines.push('Unknown-value merges');
    lines.push('---------------------');
    for (const merge of report.merges) {
      lines.push(
        `  [fn ${merge.functionIndex}] block ${merge.blockIndex}: locals ${merge.locals.join(', ')}`,
      );
    }
  }

  if (report.simplificationOpportunities.length > 0) {
    lines.push('');
    lines.push('Control-flow simplification opportunities');
    lines.push('------------------------------------------');
    for (const opportunity of report.simplificationOpportunities) {
      lines.push(
        `  [fn ${opportunity.functionIndex}] block ${opportunity.blockIndex} ` +
          `instr ${opportunity.instructionIndex}: ${opportunity.detail}`,
      );
    }
  }

  return lines.join('\n');
}

/** Renders the constant findings as CSV. */
export function constantPropagationToCsv(report: ConstantPropagationReport): string {
  const header = [
    'type',
    'function_index',
    'function_name',
    'block_index',
    'instruction_index',
    'opcode',
    'value',
    'value_type',
    'depth',
    'detail',
  ].join(',');

  const rows = report.findings.map((finding) =>
    [
      finding.type,
      finding.functionIndex,
      finding.functionName,
      finding.blockIndex,
      finding.instructionIndex,
      finding.opcode,
      finding.value ?? '',
      finding.valueType ?? '',
      finding.depth ?? '',
      finding.detail ?? '',
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

/** Renders a human-readable comparison of two constant inventories. */
export function formatConstantComparison(comparison: ConstantComparison): string {
  const lines: string[] = [];
  lines.push('WASM constant propagation comparison');
  lines.push('====================================');
  lines.push(`Old artifact: ${comparison.oldFile}`);
  lines.push(`New artifact: ${comparison.newFile}`);
  lines.push('');
  lines.push(
    `Findings (old/new):          ${comparison.summary.oldFindingCount}/${comparison.summary.newFindingCount}`,
  );
  lines.push(`Newly propagated constants:  ${comparison.summary.newlyPropagated}`);
  lines.push(`Removed propagated constants: ${comparison.summary.removedPropagated}`);
  lines.push(`Changed constant values:     ${comparison.summary.changedValues}`);
  lines.push(`Newly constant branches:     ${comparison.summary.newlyConstantBranches}`);
  lines.push(`Branches no longer constant: ${comparison.summary.unresolvableBranches}`);
  return lines.join('\n');
}

/** Re-exported for convenience. */
export type { WasmInstruction };

export { WasmParseError };
