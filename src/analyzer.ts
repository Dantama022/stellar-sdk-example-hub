import { readFileSync } from 'fs';
import { WASMParser } from './wasm-parser';
import { CFGBuilder } from './cfg-builder';
import { UnreachableAnalyzer } from './unreachable-analyzer';

export interface AnalysisResult {
  functions: FunctionAnalysis[];
  metrics: AnalysisMetrics;
  comparison?: ComparisonResult;
}

interface FunctionAnalysis {
  index: number;
  name: string;
  blocks: BlockAnalysis[];
  unreachableRegions: UnreachableRegion[];
  density: number;
}

interface BlockAnalysis {
  index: number;
  instructions: number;
  reachable: boolean;
  reason?: string;
}

interface UnreachableRegion {
  start: number;
  end: number;
  reason: string;
}

interface AnalysisMetrics {
  totalBlocks: number;
  reachableBlocks: number;
  unreachableBlocks: number;
  totalInstructions: number;
  reachableInstructions: number;
  unreachableInstructions: number;
  unreachablePercentage: number;
  functionsWithUnreachable: number;
  largestUnreachableRegion: number;
}

interface ComparisonResult {
  newlyUnreachable: number;
  newlyReachable: number;
  changedBoundaries: number;
  functionsWithNewUnreachable: number;
}

export async function analyzeWasm(
  wasmPath: string,
  comparePath?: string
): Promise<AnalysisResult> {
  const wasmBuffer = readFileSync(wasmPath);
  const parser = new WASMParser(wasmBuffer);
  const cfgBuilder = new CFGBuilder(parser.parse());
  const cfg = cfgBuilder.build();

  const analyzer = new UnreachableAnalyzer(cfg);
  const result = analyzer.analyze();

  if (comparePath) {
    const compareBuffer = readFileSync(comparePath);
    const compareParser = new WASMParser(compareBuffer);
    const compareCfg = new CFGBuilder(compareParser.parse()).build();
    result.comparison = analyzer.compare(compareCfg);
  }

  return result;
}