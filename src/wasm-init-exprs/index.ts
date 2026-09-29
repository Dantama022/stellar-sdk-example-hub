import { readFileSync } from 'fs';
import { program } from 'commander';
import { parseWasm, WasmModule, InitExpr, SectionType, DependencyGraph } from './analyzer';
import { outputJson, outputCsv, outputDot } from './output';

interface Options {
  json: boolean;
  csv: boolean;
  dot: boolean;
  compare: string | null;
}

program
  .name('wasm-init-exprs')
  .description('Analyze WASM initialization expressions')
  .argument('<wasmFile>', 'Path to WASM file')
  .option('--json', 'Output JSON report', false)
  .option('--csv', 'Output CSV expression records', false)
  .option('--dot', 'Output DOT dependency graph', false)
  .option('--compare <file>', 'Compare with another WASM file')
  .action(async (wasmFile: string, options: Options) => {
    try {
      const buffer = readFileSync(wasmFile);
      const module = parseWasm(buffer);
      const analysis = analyzeModule(module);

      if (options.compare) {
        const compareBuffer = readFileSync(options.compare);
        const compareModule = parseWasm(compareBuffer);
        const compareAnalysis = analyzeModule(compareModule);
        const diff = compareAnalyses(analysis, compareAnalysis);

        if (options.json) console.log(JSON.stringify(diff, null, 2));
        else console.log('Comparison mode requires --json');
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(analysis, null, 2));
      } else if (options.csv) {
        console.log(outputCsv(analysis));
      } else if (options.dot) {
        console.log(outputDot(analysis.dependencyGraph));
      } else {
        console.log(outputJson(analysis));
      }
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse();

interface AnalysisResult {
  module: WasmModule;
  expressions: InitExpr[];
  dependencyGraph: DependencyGraph;
  metrics: {
    totalExpressions: number;
    constantExpressions: number;
    globalDependent: number;
    importedDependent: number;
    unknownExpressions: number;
    totalReferencedGlobals: number;
    maxDependencyDepth: number;
  };
}

function analyzeModule(module: WasmModule): AnalysisResult {
  const expressions: InitExpr[] = [];
  const dependencyGraph: DependencyGraph = {
    nodes: [],
    edges: []
  };

  // Analyze global initializers
  module.globals.forEach((global, index) => {
    if (global.initExpr) {
      const expr = parseInitExpr(global.initExpr, SectionType.Global, index);
      expressions.push(expr);
      addDependencies(dependencyGraph, expr, `global_${index}`);
    }
  });

  // Analyze data segments
  module.dataSegments.forEach((segment, index) => {
    if (segment.offsetExpr) {
      const expr = parseInitExpr(segment.offsetExpr, SectionType.Data, index);
      expressions.push(expr);
      addDependencies(dependencyGraph, expr, `data_${index}`);
    }
  });

  // Analyze element segments
  module.elementSegments.forEach((segment, index) => {
    if (segment.offsetExpr) {
      const expr = parseInitExpr(segment.offsetExpr, SectionType.Element, index);
      expressions.push(expr);
      addDependencies(dependencyGraph, expr, `element_${index}`);
    }
    
    segment.elements.forEach((elem, elemIndex) => {
      if (typeof elem === 'object' && elem.initExpr) {
        const expr = parseInitExpr(
          elem.initExpr,
          SectionType.Element,
          index,
          elemIndex
        );
        expressions.push(expr);
        addDependencies(dependencyGraph, expr, `element_${index}_${elemIndex}`);
      }
    });
  });

  // Classify expressions and compute metrics
  const metrics = computeMetrics(expressions, dependencyGraph);

  return {
    module,
    expressions,
    dependencyGraph,
    metrics
  };
}

function parseInitExpr(
  rawExpr: Uint8Array,
  section: SectionType,
  entryIndex: number,
  subIndex?: number
): InitExpr {
  const opcodes: number[] = [];
  const referencedGlobals: number[] = [];
  const constants: (number | bigint)[] = [];
  let resultType: string | null = null;
  let classification: 'constant' | 'global-dependent' | 'imported-dependent' | 'local-dependent' | 'unknown' = 'unknown';
  let staticValue: number | bigint | null = null;

  // Simple parser for common init expr patterns
  // Note: Real implementation would use a proper WASM parser like wasm-parser
  let pos = 0;
  while (pos < rawExpr.length) {
    const opcode = rawExpr[pos++];
    opcodes.push(opcode);

    switch (opcode) {
      case 0x41: // i32.const
        staticValue = new DataView(rawExpr.buffer, rawExpr.byteOffset + pos, 4).getInt32(pos, true);
        pos += 4;
        constants.push(staticValue);
        classification = 'constant';
        resultType = 'i32';
        break;
      case 0x42: // i64.const
        staticValue = new DataView(rawExpr.buffer, rawExpr.byteOffset + pos, 8).getBigInt64(pos, true);
        pos += 8;
        constants.push(staticValue);
        classification = 'constant';
        resultType = 'i64';
        break;
      case 0x23: // global.get
        const globalIndex = new DataView(rawExpr.buffer, rawExpr.byteOffset + pos, 4).getUint32(pos, true);
        pos += 4;
        referencedGlobals.push(globalIndex);
        classification = 'global-dependent';
        break;
      case 0x28: // i32.add
      case 0x29: // i32.sub
      case 0x2A: // i32.mul
        // For arithmetic ops, we'd need to track stack in a real implementation
        classification = constants.length > 0 ? 'constant' : 'unknown';
        break;
      default:
        classification = 'unknown';
    }
  }

  // Determine if any referenced globals are imports
  if (referencedGlobals.length > 0) {
    // In a real implementation, we'd check the module's import section
    classification = 'global-dependent';
  }

  return {
    section,
    entryIndex,
    subIndex,
    opcodes,
    referencedGlobals,
    constants,
    resultType,
    classification,
    staticValue,
    rawBytes: Array.from(rawExpr)
  };
}

function addDependencies(graph: DependencyGraph, expr: InitExpr, nodeId: string) {
  // Add node if not exists
  if (!graph.nodes.includes(nodeId)) {
    graph.nodes.push(nodeId);
  }

  // Add edges for each referenced global
  expr.referencedGlobals.forEach(globalIndex => {
    const globalNode = `global_${globalIndex}`;
    if (!graph.nodes.includes(globalNode)) {
      graph.nodes.push(globalNode);
    }
    graph.edges.push({
      from: nodeId,
      to: globalNode
    });
  });
}

function computeMetrics(expressions: InitExpr[], graph: DependencyGraph): AnalysisResult['metrics'] {
  const classifications = expressions.map(e => e.classification);
  const allGlobals = new Set<number>();
  
  expressions.forEach(expr => {
    expr.referencedGlobals.forEach(g => allGlobals.add(g));
  });

  // Calculate max dependency depth (simplified)
  let maxDepth = 0;
  // In a real implementation, we'd do a proper graph traversal

  return {
    totalExpressions: expressions.length,
    constantExpressions: classifications.filter(c => c === 'constant').length,
    globalDependent: classifications.filter(c => c === 'global-dependent').length,
    importedDependent: classifications.filter(c => c === 'imported-dependent').length,
    unknownExpressions: classifications.filter(c => c === 'unknown').length,
    totalReferencedGlobals: allGlobals.size,
    maxDependencyDepth: maxDepth
  };
}

function compareAnalyses(a: AnalysisResult, b: AnalysisResult) {
  // Implement comparison logic
  return {
    addedExpressions: a.expressions.length - b.expressions.length,
    removedExpressions: b.expressions.length - a.expressions.length,
    // More detailed comparison would go here
  };
}