export function formatJsonOutput(data: any): string {
  return JSON.stringify(data, null, 2);
}

export function formatDotOutput(analysis: any): string {
  let dot = 'digraph DominatorTree {
';
  dot += '  rankdir=TB;
';
  dot += '  node [shape=box];
';

  for (const func of analysis.functions) {
    dot += `  subgraph cluster_${func.index} {
`;
    dot += `    label="Function ${func.index}: ${func.name}";
`;

    for (const block of func.cfg.blocks) {
      const label = `B${block.index}\n${block.instructions.join('\\n')}`;
      dot += `    ${block.index} [label="${label}"];
`;

      if (block.immediateDominator !== null) {
        dot += `    ${block.index} -> ${block.immediateDominator} [style=dashed];
`;
      }
    }

    dot += '  }
';
  }

  dot += '}
';
  return dot;
}