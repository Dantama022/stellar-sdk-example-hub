function outputJson(analysis) {
  return {
    totalFunctions: analysis.totalFunctions,
    uniqueFunctions: analysis.uniqueFunctions,
    duplicateGroups: analysis.duplicateGroups,
    duplicatedFunctions: analysis.duplicatedFunctions,
    largestGroupSize: analysis.largestGroupSize,
    duplicateCodePercentage: analysis.duplicateCodePercentage,
    duplicatedInstructionCount: analysis.duplicatedInstructionCount,
    groups: analysis.groups.map(group => ({
      functions: group.functions,
      bodySize: group.bodySize,
      fingerprint: group.fingerprint,
      instructionCount: group.instructionCount,
      similarity: group.similarity
    }))
  };
}

function outputCsv(analysis) {
  const headers = ['Group', 'Functions', 'Size', 'Instructions', 'Similarity', 'Fingerprint'];
  const rows = analysis.groups.map((group, i) => [
    i + 1,
    `"${group.functions.join(',')}"`,
    group.bodySize,
    group.instructionCount,
    group.similarity,
    group.fingerprint
  ]);

  const lines = [headers.join(','), ...rows.map(row => row.join(','))];
  return lines.join('\n');
}

function outputDot(analysis) {
  const edges = [];
  const nodes = new Set();

  for (const group of analysis.groups) {
    if (group.functions.length > 1) {
      const label = `Group ${group.functions.join(',')}\nSize: ${group.bodySize}\nInstructions: ${group.instructionCount}`;
      nodes.add(`  "group_${group.fingerprint}" [label="${label}", shape=box];`);

      for (const func of group.functions) {
        nodes.add(`  "func_${func}" [label="Function ${func}"];`);
        edges.push(`  "func_${func}" -> "group_${group.fingerprint}" [label="${group.similarity}"];`);
      }
    }
  }

  const lines = ['digraph duplicates {', ...Array.from(nodes), ...edges, '}'];
  return lines.join('\n');
}

module.exports = { outputJson, outputCsv, outputDot };
