import {
  ConstantAnalysisResult,
  ComparisonResult,
  FunctionAnalysis
} from '../analysis/wasm-constants.js';

export function formatJsonOutput(result: ConstantAnalysisResult, includeDepth: boolean = false): string {
  const output: any = {
    module: result.moduleName || 'unknown',
    summary: {
      totalFunctions: result.functions.length,
      ...result.stats
    },
    functions: result.functions.map(formatFunctionAnalysis)
  };

  if (includeDepth) {
    output.summary.maxPropagationDepth = result.stats.maxPropagationDepth;
  }

  return JSON.stringify(output, null, 2);
}

export function formatCsvOutput(result: ConstantAnalysisResult): string {
  const headers = [
    'Function Index',
    'Function Name',
    'Instruction Index',
    'Block Index',
    'Type',
    'Value',
    'Depth'
  ];

  const rows: string[][] = [];

  for (const func of result.functions) {
    for (const constant of func.constants) {
      rows.push([
        func.index.toString(),
        func.name || '',
        constant.instructionIndex.toString(),
        constant.blockIndex?.toString() || '',
        constant.value.type,
        constant.value.value.toString(),
        constant.depth.toString()
      ]);
    }
  }

  return [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
  ].join('\n');
}

export function formatComparisonOutput(comparison: ComparisonResult, includeDepth: boolean = false): string {
  const output: any = {
    newlyPropagated: comparison.newlyPropagated,
    removedPropagated: comparison.removedPropagated,
    changedValues: comparison.changedValues,
    newConstantBranches: comparison.newConstantBranches,
    lostConstantBranches: comparison.lostConstantBranches,
    counts: {
      newlyPropagated: comparison.newlyPropagated.length,
      removedPropagated: comparison.removedPropagated.length,
      changedValues: comparison.changedValues.length,
      newConstantBranches: comparison.newConstantBranches.length,
      lostConstantBranches: comparison.lostConstantBranches.length
    }
  };

  if (includeDepth) {
    // Depth information would be included if available in the comparison
  }

  return JSON.stringify(output, null, 2);
}

function formatFunctionAnalysis(func: FunctionAnalysis): any {
  return {
    index: func.index,
    name: func.name || null,
    stats: func.stats,
    constants: func.constants.map(constant => ({
      instructionIndex: constant.instructionIndex,
      blockIndex: constant.blockIndex,
      type: constant.value.type,
      value: formatConstantValue(constant.value),
      depth: constant.depth
    })),
    constantBranches: func.constantBranches
  };
}

function formatConstantValue(value: { type: string; value: number | bigint }): string | number {
  if (typeof value.value === 'bigint') {
    return value.value.toString();
  }
  return value.value;
}