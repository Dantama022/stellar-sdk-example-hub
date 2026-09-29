import { AnalysisResult, InitExpr } from './analyzer';

export function outputJson(analysis: AnalysisResult): string {
  return JSON.stringify({
    metadata: {
      totalExpressions: analysis.metrics.totalExpressions,
      constantExpressions: analysis.metrics.constantExpressions,
      globalDependent: analysis.metrics.globalDependent,
      importedDependent: analysis.metrics.importedDependent,
      unknownExpressions: analysis.metrics.unknownExpressions,
      totalReferencedGlobals: analysis.metrics.totalReferencedGlobals,
      maxDependencyDepth: analysis.metrics.maxDependencyDepth
    },
    expressions: analysis.expressions.map(exprToJson),
    dependencyGraph: {
      nodes: analysis.dependencyGraph.nodes,
      edges: analysis.dependencyGraph.edges
    }
  }, null, 2);
}

function exprToJson(expr: InitExpr) {
  return {
    section: expr.section,
    entryIndex: expr.entryIndex,
    subIndex: expr.subIndex,
    opcodes: expr.opcodes.map(op => `0x${op.toString(16).padStart(2, '0')}`),
    referencedGlobals: expr.referencedGlobals,
    constants: expr.constants.map(c => typeof c === 'bigint' ? c.toString() : c),
    resultType: expr.resultType,
    classification: expr.classification,
    staticValue: expr.staticValue !== null ? 
      (typeof expr.staticValue === 'bigint' ? expr.staticValue.toString() : expr.staticValue) :
      null
  };
}

export function outputCsv(analysis: AnalysisResult): string {
  const headers = [
    'Section',
    'Entry Index',
    'Sub Index',
    'Opcodes',
    'Referenced Globals',
    'Constants',
    'Result Type',
    'Classification',
    'Static Value'
  ];

  const rows = analysis.expressions.map(expr => [
    expr.section,
    expr.entryIndex,
    expr.subIndex ?? '',
    expr.opcodes.map(op => `0x${op.toString(16).padStart(2, '0')}`).join(' '),
    expr.referencedGlobals.join(','),
    expr.constants.map(c => typeof c === 'bigint' ? c.toString() : c).join(','),
    expr.resultType ?? '',
    expr.classification,
    expr.staticValue !== null ? 
      (typeof expr.staticValue === 'bigint' ? expr.staticValue.toString() : expr.staticValue) :
      ''
  ]);

  return [
    headers.join(','),
    ...rows.map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
  ].join('\n');
}

export function outputDot(graph: { nodes: string[]; edges: { from: string; to: string }[] }): string {
  const lines: string[] = [
    'digraph InitExprDependencies {',
    '  rankdir=LR;',
    '  node [shape=box];'
  ];

  // Add nodes
  graph.nodes.forEach(node => {
    lines.push(`  "${node}";`);
  });

  // Add edges
  graph.edges.forEach(edge => {
    lines.push(`  "${edge.from}" -> "${edge.to}";`);
  });

  lines.push('}');
  return lines.join('\n');
}