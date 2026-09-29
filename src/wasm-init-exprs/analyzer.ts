export type SectionType = 'global' | 'data' | 'element';

export interface InitExpr {
  section: SectionType;
  entryIndex: number;
  subIndex?: number;
  opcodes: number[];
  referencedGlobals: number[];
  constants: (number | bigint)[];
  resultType: string | null;
  classification: 'constant' | 'global-dependent' | 'imported-dependent' | 'local-dependent' | 'unknown';
  staticValue: number | bigint | null;
  rawBytes: number[];
}

export interface DependencyGraph {
  nodes: string[];
  edges: { from: string; to: string }[];
}

export interface WasmModule {
  globals: {
    type: string;
    mutable: boolean;
    initExpr?: Uint8Array;
  }[];
  dataSegments: {
    memoryIndex: number;
    offsetExpr?: Uint8Array;
    data: Uint8Array;
  }[];
  elementSegments: {
    tableIndex: number;
    offsetExpr?: Uint8Array;
    elements: (number | { initExpr: Uint8Array })[];
  }[];
  imports?: {
    module: string;
    name: string;
    kind: 'global' | 'memory' | 'table' | 'func';
    type?: string;
  }[];
}

export function parseWasm(buffer: Buffer): WasmModule {
  // In a real implementation, this would use a proper WASM parser
  // This is a simplified mock implementation
  
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  let pos = 0;

  // Skip magic number and version
  if (view.getUint32(pos, false) !== 0x6D736100) {
    throw new Error('Invalid WASM magic number');
  }
  pos += 4;
  
  if (view.getUint32(pos, false) !== 1) {
    throw new Error('Unsupported WASM version');
  }
  pos += 4;

  const module: WasmModule = {
    globals: [],
    dataSegments: [],
    elementSegments: []
  };

  // Parse sections
  while (pos < buffer.length) {
    const sectionId = view.getUint8(pos++);
    const sectionSize = view.getUint32(pos, true);
    pos += 4;
    const sectionEnd = pos + sectionSize;

    switch (sectionId) {
      case 6: // Global section
        const globalCount = view.getUint32(pos, true);
        pos += 4;
        for (let i = 0; i < globalCount; i++) {
          const type = view.getUint8(pos++);
          const mutable = view.getUint8(pos++) !== 0;
          const initExprLength = view.getUint32(pos, true);
          pos += 4;
          const initExpr = buffer.slice(pos, pos + initExprLength);
          pos += initExprLength;
          
          module.globals.push({
            type: type === 0x7F ? 'i32' : type === 0x7E ? 'i64' : 'unknown',
            mutable,
            initExpr
          });
        }
        break;

      case 11: // Data section
        const dataCount = view.getUint32(pos, true);
        pos += 4;
        for (let i = 0; i < dataCount; i++) {
          const memoryIndex = view.getUint32(pos, true);
          pos += 4;
          const offsetExprLength = view.getUint32(pos, true);
          pos += 4;
          const offsetExpr = buffer.slice(pos, pos + offsetExprLength);
          pos += offsetExprLength;
          const dataLength = view.getUint32(pos, true);
          pos += 4;
          const data = buffer.slice(pos, pos + dataLength);
          pos += dataLength;

          module.dataSegments.push({
            memoryIndex,
            offsetExpr,
            data
          });
        }
        break;

      case 12: // Element section
        const elementCount = view.getUint32(pos, true);
        pos += 4;
        for (let i = 0; i < elementCount; i++) {
          const tableIndex = view.getUint32(pos, true);
          pos += 4;
          const offsetExprLength = view.getUint32(pos, true);
          pos += 4;
          const offsetExpr = buffer.slice(pos, pos + offsetExprLength);
          pos += offsetExprLength;
          const elementCount = view.getUint32(pos, true);
          pos += 4;
          const elements: (number | { initExpr: Uint8Array })[] = [];
          
          for (let j = 0; j < elementCount; j++) {
            // Simplified - in reality element items can be more complex
            const isExpr = view.getUint8(pos) === 0x00; // Check for expr flag
            if (isExpr) {
              pos++; // Skip flag
              const exprLength = view.getUint32(pos, true);
              pos += 4;
              const initExpr = buffer.slice(pos, pos + exprLength);
              pos += exprLength;
              elements.push({ initExpr });
            } else {
              const funcIndex = view.getUint32(pos, true);
              pos += 4;
              elements.push(funcIndex);
            }
          }

          module.elementSegments.push({
            tableIndex,
            offsetExpr,
            elements
          });
        }
        break;

      default:
        // Skip other sections
        pos = sectionEnd;
    }
  }

  return module;
}