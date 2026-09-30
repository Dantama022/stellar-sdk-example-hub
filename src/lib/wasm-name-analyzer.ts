export interface NamedEntity {
  index: number;
  name: string;
}

export interface LocalName {
  index: number;
  name: string;
}

export interface FunctionLocalNames {
  functionIndex: number;
  locals: LocalName[];
}

export interface FunctionWithLocalCount {
  functionIndex: number;
  name: string | null;
  localCount: number;
}

export interface NameSectionAnalysis {
  hasNameSection: boolean;
  totalFunctions: number;
  namedFunctions: NamedEntity[];
  unnamedFunctions: number[];
  functionsWithLocals: number[];
  functionLocals: FunctionLocalNames[];
  totalNamedLocals: number;
  functionsWithMostLocals: FunctionWithLocalCount[];
}

export interface FunctionNameChange {
  index: number;
  oldName: string;
  newName: string;
}

export interface LocalNameChange {
  functionIndex: number;
  index: number;
  oldName: string;
  newName: string;
}

export interface LocalNameInfo {
  functionIndex: number;
  index: number;
  name: string;
}

export interface ComparisonResult {
  addedFunctionNames: NamedEntity[];
  removedFunctionNames: NamedEntity[];
  renamedFunctions: FunctionNameChange[];
  addedLocalNames: LocalNameInfo[];
  removedLocalNames: LocalNameInfo[];
  changedLocalNames: LocalNameChange[];
}

// WASM name section types
const NAME_SECTION_ID = 0;
const FUNCTION_NAME_SUBSECTION_ID = 1;
const LOCAL_NAME_SUBSECTION_ID = 2;

export class WasmNameAnalyzer {
  analyzeWasmModule(wasmBuffer: Buffer): NameSectionAnalysis {
    let hasNameSection = false;
    let namedFunctions: NamedEntity[] = [];
    let functionLocals: FunctionLocalNames[] = [];
    let totalFunctions = 0;

    try {
      // Simple WASM parsing for name section (without full validation)
      const view = new DataView(wasmBuffer.buffer, wasmBuffer.byteOffset, wasmBuffer.byteLength);
      let pos = 0;

      // Skip magic number and version
      if (wasmBuffer.readUInt32LE(0) !== 0x6D736100) {
        throw new Error('Invalid WASM magic number');
      }
      pos = 8; // Skip magic (4) + version (4)

      while (pos < wasmBuffer.length) {
        const sectionId = wasmBuffer.readUInt8(pos++);
        const sectionSize = wasmBuffer.readUInt32LE(pos);
        pos += 4;
        const sectionEnd = pos + sectionSize;

        if (sectionId === 0) { // Custom section
          const nameLength = wasmBuffer.readUInt32LE(pos);
          pos += 4;
          const name = wasmBuffer.toString('utf8', pos, pos + nameLength);
          pos += nameLength;

          if (name === 'name') {
            hasNameSection = true;
            this.parseNameSection(wasmBuffer, pos, sectionEnd, {
              onFunctionNames: (names) => { namedFunctions = names; },
              onLocalNames: (locals) => { functionLocals = locals; }
            });
          }
        } else if (sectionId === 3) { // Function section
          const count = wasmBuffer.readUInt32LE(pos);
          pos += 4;
          totalFunctions = count;
          pos = sectionEnd; // Skip function type indexes
        }

        pos = sectionEnd;
      }
    } catch (error) {
      // Continue with partial results if name section is malformed
      hasNameSection = namedFunctions.length > 0 || functionLocals.length > 0;
    }

    // Build analysis results
    const unnamedFunctions: number[] = [];
    const functionsWithLocals: number[] = [];
    const localCounts: Map<number, number> = new Map();

    for (let i = 0; i < totalFunctions; i++) {
      const hasName = namedFunctions.some(fn => fn.index === i);
      if (!hasName) {
        unnamedFunctions.push(i);
      }

      const funcLocals = functionLocals.find(fl => fl.functionIndex === i);
      if (funcLocals && funcLocals.locals.length > 0) {
        functionsWithLocals.push(i);
        localCounts.set(i, funcLocals.locals.length);
      }
    }

    const totalNamedLocals = Array.from(localCounts.values()).reduce((sum, count) => sum + count, 0);

    // Get functions with most locals
    const functionsWithMostLocals: FunctionWithLocalCount[] = [];
    if (localCounts.size > 0) {
      const maxCount = Math.max(...localCounts.values());
      for (const [funcIndex, count] of localCounts) {
        if (count === maxCount) {
          const funcName = namedFunctions.find(fn => fn.index === funcIndex)?.name || null;
          functionsWithMostLocals.push({ functionIndex: funcIndex, name: funcName, localCount: count });
        }
      }
    }

    return {
      hasNameSection,
      totalFunctions,
      namedFunctions,
      unnamedFunctions,
      functionsWithLocals,
      functionLocals,
      totalNamedLocals,
      functionsWithMostLocals
    };
  }

  compareWasmModules(wasm1: Buffer, wasm2: Buffer): ComparisonResult {
    const analysis1 = this.analyzeWasmModule(wasm1);
    const analysis2 = this.analyzeWasmModule(wasm2);

    const result: ComparisonResult = {
      addedFunctionNames: [],
      removedFunctionNames: [],
      renamedFunctions: [],
      addedLocalNames: [],
      removedLocalNames: [],
      changedLocalNames: []
    };

    // Compare function names
    const funcNames1 = new Map<number, string>(
      analysis1.namedFunctions.map(fn => [fn.index, fn.name])
    );
    const funcNames2 = new Map<number, string>(
      analysis2.namedFunctions.map(fn => [fn.index, fn.name])
    );

    // All function indexes from both modules
    const allFuncIndexes = new Set<number>([
      ...analysis1.namedFunctions.map(fn => fn.index),
      ...analysis2.namedFunctions.map(fn => fn.index),
      ...analysis1.unnamedFunctions,
      ...analysis2.unnamedFunctions
    ]);

    for (const index of allFuncIndexes) {
      const name1 = funcNames1.get(index);
      const name2 = funcNames2.get(index);

      if (name1 && !name2) {
        result.removedFunctionNames.push({ index, name: name1 });
      } else if (!name1 && name2) {
        result.addedFunctionNames.push({ index, name: name2 });
      } else if (name1 && name2 && name1 !== name2) {
        result.renamedFunctions.push({ index, oldName: name1, newName: name2 });
      }
    }

    // Compare local names
    const locals1 = new Map<string, string>([
      ...analysis1.functionLocals.flatMap(fl =>
        fl.locals.map(local =>
          [`${fl.functionIndex}:${local.index}`, local.name] as [string, string]
        )
      )
    ]);
    const locals2 = new Map<string, string>([
      ...analysis2.functionLocals.flatMap(fl =>
        fl.locals.map(local =>
          [`${fl.functionIndex}:${local.index}`, local.name] as [string, string]
        )
      )
    ]);

    const allLocalKeys = new Set<string>([
      ...locals1.keys(),
      ...locals2.keys()
    ]);

    for (const key of allLocalKeys) {
      const [funcIndexStr, localIndexStr] = key.split(':');
      const funcIndex = parseInt(funcIndexStr);
      const localIndex = parseInt(localIndexStr);

      const name1 = locals1.get(key);
      const name2 = locals2.get(key);

      if (name1 && !name2) {
        result.removedLocalNames.push({ functionIndex: funcIndex, index: localIndex, name: name1 });
      } else if (!name1 && name2) {
        result.addedLocalNames.push({ functionIndex: funcIndex, index: localIndex, name: name2 });
      } else if (name1 && name2 && name1 !== name2) {
        result.changedLocalNames.push({
          functionIndex: funcIndex,
          index: localIndex,
          oldName: name1,
          newName: name2
        });
      }
    }

    return result;
  }

  private parseNameSection(
    buffer: Buffer,
    start: number,
    end: number,
    callbacks: {
      onFunctionNames?: (names: NamedEntity[]) => void;
      onLocalNames?: (locals: FunctionLocalNames[]) => void;
    }
  ) {
    const functionNames: NamedEntity[] = [];
    const functionLocals: FunctionLocalNames[] = [];
    let pos = start;

    while (pos < end) {
      const subsectionType = buffer.readUInt8(pos++);
      const subsectionSize = buffer.readUInt32LE(pos);
      pos += 4;
      const subsectionEnd = pos + subsectionSize;

      switch (subsectionType) {
        case FUNCTION_NAME_SUBSECTION_ID:
          this.parseFunctionNameSubsection(buffer, pos, subsectionEnd, functionNames);
          break;
        case LOCAL_NAME_SUBSECTION_ID:
          this.parseLocalNameSubsection(buffer, pos, subsectionEnd, functionLocals);
          break;
        default:
          // Skip unknown subsection types
          break;
      }

      pos = subsectionEnd;
    }

    if (callbacks.onFunctionNames) {
      callbacks.onFunctionNames(functionNames);
    }
    if (callbacks.onLocalNames) {
      callbacks.onLocalNames(functionLocals);
    }
  }

  private parseFunctionNameSubsection(
    buffer: Buffer,
    start: number,
    end: number,
    output: NamedEntity[]
  ) {
    let pos = start;
    const count = buffer.readUInt32LE(pos);
    pos += 4;

    for (let i = 0; i < count; i++) {
      const index = buffer.readUInt32LE(pos);
      pos += 4;
      const nameLength = buffer.readUInt32LE(pos);
      pos += 4;
      const name = buffer.toString('utf8', pos, pos + nameLength);
      pos += nameLength;

      output.push({ index, name });
    }
  }

  private parseLocalNameSubsection(
    buffer: Buffer,
    start: number,
    end: number,
    output: FunctionLocalNames[]
  ) {
    let pos = start;
    const functionCount = buffer.readUInt32LE(pos);
    pos += 4;

    for (let i = 0; i < functionCount; i++) {
      const functionIndex = buffer.readUInt32LE(pos);
      pos += 4;
      const localCount = buffer.readUInt32LE(pos);
      pos += 4;

      const locals: LocalName[] = [];
      for (let j = 0; j < localCount; j++) {
        const localIndex = buffer.readUInt32LE(pos);
        pos += 4;
        const nameLength = buffer.readUInt32LE(pos);
        pos += 4;
        const name = buffer.toString('utf8', pos, pos + nameLength);
        pos += nameLength;

        locals.push({ index: localIndex, name });
      }

      output.push({ functionIndex, locals });
    }
  }
}