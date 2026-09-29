export function formatJsonOutput(data: any): string {
  return JSON.stringify(data, null, 2);
}

export function formatDotOutput(analysis: any): string {
  let dot = 'digraph DominatorTree {\n';
  dot += '  rankdir=TB;\n';
  dot += '  node [shape=box];\n';

  for (const func of analysis.functions || []) {
    dot += `  subgraph cluster_${func.index} {\n`;
    dot += `    label="Function ${func.index}: ${func.name}";\n`;

    for (const block of func.cfg?.blocks || []) {
      const label = `B${block.index}\\n${(block.instructions || []).join('\\n')}`;
      dot += `    ${block.index} [label="${label}"];\n`;

      if (block.immediateDominator !== null && block.immediateDominator !== undefined) {
        dot += `    ${block.index} -> ${block.immediateDominator} [style=dashed];\n`;
      }
    }

    dot += '  }\n';
  }

  dot += '}\n';
  return dot;
}

export function formatCsvOutput(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      const val = row[h];
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n');
}