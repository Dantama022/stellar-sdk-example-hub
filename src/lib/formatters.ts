import { MemoryAccessAnalysis, ComparisonResult } from './wasm-memory-analyzer';

export function formatJsonOutput(data: MemoryAccessAnalysis | ComparisonResult): string {
  return JSON.stringify(data, null, 2);
}

export function formatCsvOutput(
  data: MemoryAccessAnalysis | ComparisonResult,
  includeAccessDetails: boolean = false
): string {
  if ('differences' in data) {
    // Comparison mode
    return formatComparisonCsv(data as ComparisonResult, includeAccessDetails);
  } else {
    // Single analysis mode
    return formatAnalysisCsv(data as MemoryAccessAnalysis, includeAccessDetails);
  }
}

function formatAnalysisCsv(
  analysis: MemoryAccessAnalysis,
  includeAccessDetails: boolean
): string {
  const lines: string[] = [];

  // Module-level stats
  lines.push('Module,' + analysis.moduleName);
  lines.push('Total Functions,' + analysis.moduleStats.totalFunctions);
  lines.push('Total Loads,' + analysis.moduleStats.totalLoads);
  lines.push('Total Stores,' + analysis.moduleStats.totalStores);
  lines.push('Total Accesses,' + analysis.moduleStats.totalAccesses);
  lines.push('Overall Read/Write Ratio,' + analysis.moduleStats.overallReadWriteRatio.toFixed(2));
  lines.push('');

  // Function-level stats
  lines.push('Function Stats');
  lines.push('Function Index,Total Loads,Total Stores,Total Accesses,Read/Write Ratio,Unique Widths,Unique Offsets,Max Offset,Read Only,Write Only');

  for (const stats of analysis.functionStats) {
    const uniqueWidths = Array.from(stats.uniqueAccessWidths).sort((a, b) => a - b).join('|');
    const uniqueOffsets = Array.from(stats.uniqueStaticOffsets)
      .filter(o => o !== null)
      .sort((a, b) => (a || 0) - (b || 0))
      .map(o => o?.toString() || 'null')
      .join('|');

    lines.push([
      stats.functionIndex,
      stats.totalLoads,
      stats.totalStores,
      stats.totalAccesses,
      stats.readWriteRatio.toFixed(2),
      uniqueWidths || 'none',
      uniqueOffsets || 'none',
      stats.maxStaticOffset?.toString() || 'none',
      stats.isReadOnly.toString(),
      stats.isWriteOnly.toString()
    ].join(','));
  }

  if (includeAccessDetails && analysis.accesses.length > 0) {
    lines.push('');
    lines.push('Access Details');
    lines.push('Function Index,Basic Block,Instruction Index,Opcode,Width,Alignment,Static Offset,Memory Index,Is Load,Is Store');

    for (const access of analysis.accesses) {
      lines.push([
        access.functionIndex,
        access.basicBlock,
        access.instructionIndex,
        access.opcode,
        access.accessWidth,
        access.alignment,
        access.staticOffset?.toString() || 'null',
        access.memoryIndex?.toString() || 'null',
        access.isLoad.toString(),
        access.isStore.toString()
      ].join(','));
    }
  }

  return lines.join('\n');
}

function formatComparisonCsv(
  comparison: ComparisonResult,
  includeAccessDetails: boolean
): string {
  const lines: string[] = [];

  // Header
  lines.push('Comparison Results');
  lines.push('');

  // Original stats
  lines.push('Original Module,' + comparison.original.moduleName);
  lines.push('Original Total Accesses,' + comparison.original.moduleStats.totalAccesses);
  lines.push('');

  // Modified stats
  lines.push('Modified Module,' + comparison.modified.moduleName);
  lines.push('Modified Total Accesses,' + comparison.modified.moduleStats.totalAccesses);
  lines.push('');

  // Differences
  lines.push('Differences');
  lines.push('Added Access Sites,' + comparison.differences.addedAccessSites.length);
  lines.push('Removed Access Sites,' + comparison.differences.removedAccessSites.length);
  lines.push('Changed Operations,' + comparison.differences.changedOperations.length);
  lines.push('Changed Widths,' + comparison.differences.changedWidths.length);
  lines.push('Changed Offsets,' + comparison.differences.changedOffsets.length);
  lines.push('New Memory Access Functions,' + comparison.differences.newMemoryAccessFunctions.length);

  if (includeAccessDetails) {
    // Add detailed comparison if requested
    if (comparison.differences.addedAccessSites.length > 0) {
      lines.push('');
      lines.push('Added Access Sites');
      lines.push('Function Index,Basic Block,Instruction Index,Opcode,Width,Alignment,Static Offset');
      for (const site of comparison.differences.addedAccessSites) {
        lines.push([
          site.functionIndex,
          site.basicBlock,
          site.instructionIndex,
          site.opcode,
          site.accessWidth,
          site.alignment,
          site.staticOffset?.toString() || 'null'
        ].join(','));
      }
    }

    if (comparison.differences.removedAccessSites.length > 0) {
      lines.push('');
      lines.push('Removed Access Sites');
      lines.push('Function Index,Basic Block,Instruction Index,Opcode,Width,Alignment,Static Offset');
      for (const site of comparison.differences.removedAccessSites) {
        lines.push([
          site.functionIndex,
          site.basicBlock,
          site.instructionIndex,
          site.opcode,
          site.accessWidth,
          site.alignment,
          site.staticOffset?.toString() || 'null'
        ].join(','));
      }
    }
  }

  return lines.join('\n');
}