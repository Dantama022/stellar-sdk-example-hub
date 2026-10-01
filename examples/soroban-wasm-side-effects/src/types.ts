export type SideEffectType = 
  | 'pure'
  | 'read-only'
  | 'state-mutating'
  | 'externally-dependent'
  | 'effectful'
  | 'unknown';

export interface SideEffectEvidence {
  memoryWrites: boolean;
  memoryReads: boolean;
  mutableGlobalWrites: string[];
  mutableGlobalReads: string[];
  tableMutations: boolean;
  importedCalls: string[];
  indirectCalls: boolean;
  trappingOps: boolean;
  transitiveEffects: SideEffectType[];
}

export interface FunctionAnalysis {
  name: string;
  classification: SideEffectType;
  evidence: SideEffectEvidence;
  callees: string[];
  callers: string[];
}

export interface AnalysisResult {
  functions: FunctionAnalysis[];
  summary: {
    total: number;
    pure: number;
    readOnly: number;
    stateMutating: number;
    externallyDependent: number;
    effectful: number;
    unknown: number;
    transitiveEffectful: number;
  };
}

export interface CLIOptions {
  wasmFile: string;
  output: string;
  format: 'json' | 'csv' | 'dot';
  verbose: boolean;
}