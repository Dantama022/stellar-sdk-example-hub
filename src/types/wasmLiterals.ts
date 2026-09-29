export type LiteralType = 'i32' | 'i64' | 'f32' | 'f64';

export type ClassificationPattern =
  | 'zero'
  | 'one'
  | 'negative-one'
  | 'power-of-two'
  | 'bit-mask'
  | 'byte-mask'
  | 'alignment-like';

export interface LiteralOccurrence {
  functionIndex: number | null;
  blockIndex: number | null;
  instructionIndex: number | null;
  opcode: number | null;
  rawValue: bigint | number;
  bitWidth: number;
  literalType: LiteralType;
}

export interface LiteralInfo {
  normalizedValue: string;
  signedValue: bigint | number | null;
  unsignedValue: bigint | number | null;
  hexValue: string | null;
  bitWidth: number;
  literalType: LiteralType;
  occurrences: LiteralOccurrence[];
  occurrenceCount: number;
  classifications: ClassificationPattern[];
}

export interface WasmLiteralStatistics {
  totalOccurrences: number;
  uniqueLiterals: number;
  integerLiterals: number;
  floatLiterals: number;
  mostFrequentLiteral: string | null;
  minInteger: number | null;
  maxInteger: number | null;
  sharedAcrossFunctions: number;
  sharedAcrossOpcodeCategories: number;
}

export interface WasmLiteralAnalysis {
  file: string;
  literals: LiteralInfo[];
  statistics: WasmLiteralStatistics;
  comparison?: {
    file: string;
    sharedLiterals: string[];
    uniqueToFirst: string[];
    uniqueToSecond: string[];
  };
}

export type LiteralOutputFormat = 'json' | 'csv';
