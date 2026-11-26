export function formatJsonOutput(data: any): string {
  return JSON.stringify(data, null, 2);
}

export function formatDotOutput(analysis: any): string {
  let dot = 'digraph DominatorTree {\n';
  dot += '  rankdir=TB;\n';
  dot += '  node [shape=box];\n';

  for (const func of analysis.functions) {
    dot += `  subgraph cluster_${func.index} {\n`;
    dot += `    label="Function ${func.index}: ${func.name}";\n`;

    for (const block of func.cfg.blocks) {
      const label = `B${block.index}\\n${block.instructions.join('\\n')}`;
      dot += `    ${block.index} [label="${label}"];\n`;

      if (block.immediateDominator !== null) {
        dot += `    ${block.index} -> ${block.immediateDominator} [style=dashed];\n`;
      }
    }

    dot += '  }\n';
  }

  dot += '}\n';
  return dot;
}
