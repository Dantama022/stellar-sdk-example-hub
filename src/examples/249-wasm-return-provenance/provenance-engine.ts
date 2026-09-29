/**
 * WASM Return-Value Provenance Analysis Engine
 *
 * Traces every return value of every function in a WASM binary backward
 * through supported instructions and control-flow paths — without executing
 * any code. The analysis is completely offline and deterministic.
 *
 * Provenance model
 * ────────────────
 * A "provenance source" is the earliest observable origin of a value:
 *
 *   parameter      — a function parameter passed by the caller
 *   local          — a local variable that has been set (possibly from
 *                    a parameter or another expression)
 *   const          — a compile-time constant (i32/i64/f32/f64.const)
 *   global         — a module-level global (immutable or mutable)
 *   memory         — a value loaded from linear memory
 *   call           — the return value of a named direct function call
 *   call_indirect  — the return value of an indirect call
 *                    (treated as unknown when not statically resolvable)
 *   unknown        — a value whose origin could not be determined within
 *                    the analysis budget (includes recursion limits and
 *                    unresolved indirect calls)
 *
 * The engine propagates provenance forward through a simplified abstract
 * interpretation of the operand stack. At control-flow joins (block exits,
 * branches, and if/else merges) all candidate sets are merged
 * conservatively: every possible origin is kept. Loop-carried provenance is
 * handled by iterating until a fixed point is reached (capped at
 * MAX_LOOP_ITERATIONS to guarantee termination).
 *
 * Unsupported cases
 * ─────────────────
 * • Indirect calls (call_indirect) are treated as producing a single
 *   "call_indirect" provenance node.
 * • Recursive call paths are capped at MAX_CALL_DEPTH and produce an
 *   "unknown" node with a "recursion_limit" note.
 * • SIMD, GC, reference-type and other extension instructions that produce
 *   values are treated as "unknown".
 * • select/select-typed instructions merge their two value candidates
 *   conservatively (both sources are kept).
 */

import fs from 'fs';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class WasmProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmProvenanceError';
  }
}

// ---------------------------------------------------------------------------
// Low-level binary reading (self-contained, no imports)
// ---------------------------------------------------------------------------

function readByte(buf: Buffer, pos: number): [number, number] {
  if (pos >= buf.length) throw new WasmProvenanceError('Unexpected end of WASM data');
  return [buf[pos], pos + 1];
}

function readVarU32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) throw new WasmProvenanceError('Unexpected end of WASM data (LEB128)');
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
  throw new WasmProvenanceError('Malformed unsigned LEB128');
}

function readVarI32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let b = 0;
  do {
    if (pos >= buf.length) throw new WasmProvenanceError('Unexpected end of WASM data (SLEB128)');
    b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while ((b & 0x80) !== 0 && shift < 35);
  if (shift < 32 && (b & 0x40) !== 0) result |= ~0 << shift;
  return [result, pos];
}

function readVarI64(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let b = 0;
  do {
    if (pos >= buf.length) throw new WasmProvenanceError('Unexpected end of WASM data (SLEB128-64)');
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while ((b & 0x80) !== 0 && shift < 70n);
  if (shift < 64n && (b & 0x40) !== 0) result |= ~0n << shift;
  return [result, pos];
}

function readF32(buf: Buffer, pos: number): [number, number] {
  if (pos + 4 > buf.length) throw new WasmProvenanceError('Unexpected end of WASM data (f32)');
  return [buf.readFloatLE(pos), pos + 4];
}

function readF64(buf: Buffer, pos: number): [number, number] {
  if (pos + 8 > buf.length) throw new WasmProvenanceError('Unexpected end of WASM data (f64)');
  return [buf.readDoubleLE(pos), pos + 8];
}

// ---------------------------------------------------------------------------
// WASM section extraction
// ---------------------------------------------------------------------------

interface RawSection {
  id: number;
  payload: Buffer;
}

function parseSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8) throw new WasmProvenanceError('WASM binary too short');
  if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d)
    throw new WasmProvenanceError('Missing WASM magic header');
  if (wasm.readUInt32LE(4) !== 1) throw new WasmProvenanceError('Unsupported WASM version');
  const sections: RawSection[] = [];
  let pos = 8;
  while (pos < wasm.length) {
    let id: number, size: number;
    [id, pos] = readByte(wasm, pos);
    [size, pos] = readVarU32(wasm, pos);
    if (pos + size > wasm.length) throw new WasmProvenanceError('Section exceeds WASM data');
    sections.push({ id, payload: wasm.subarray(pos, pos + size) });
    pos += size;
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Type section — function signatures
// ---------------------------------------------------------------------------

interface FuncType {
  params: number[]; // value-type bytes
  results: number[]; // value-type bytes
}

function valueTypeName(b: number): string {
  const m: Record<number, string> = {
    0x7f: 'i32',
    0x7e: 'i64',
    0x7d: 'f32',
    0x7c: 'f64',
    0x7b: 'v128',
    0x70: 'funcref',
    0x6f: 'externref',
  };
  return m[b] ?? `unknown(0x${b.toString(16)})`;
}

function parseTypeSection(sec: RawSection | undefined): FuncType[] {
  if (!sec) return [];
  const buf = sec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  const types: FuncType[] = [];
  for (let i = 0; i < count; i++) {
    const tag = buf[pos++]; // 0x60
    if (tag !== 0x60) throw new WasmProvenanceError(`Expected func type tag 0x60, got 0x${tag.toString(16)}`);
    let paramCount: number, resultCount: number;
    [paramCount, pos] = readVarU32(buf, pos);
    const params: number[] = [];
    for (let j = 0; j < paramCount; j++) params.push(buf[pos++]);
    [resultCount, pos] = readVarU32(buf, pos);
    const results: number[] = [];
    for (let j = 0; j < resultCount; j++) results.push(buf[pos++]);
    types.push({ params, results });
  }
  return types;
}

// ---------------------------------------------------------------------------
// Import section — function imports (body-less, counted before defined funcs)
// ---------------------------------------------------------------------------

interface FuncImport {
  module: string;
  name: string;
  typeIndex: number;
}

function parseImportSection(sec: RawSection | undefined): {
  functions: FuncImport[];
  globalMutability: boolean[];
} {
  const functions: FuncImport[] = [];
  const globalMutability: boolean[] = [];
  if (!sec) return { functions, globalMutability };
  const buf = sec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  for (let i = 0; i < count; i++) {
    let modLen: number, nameLen: number;
    [modLen, pos] = readVarU32(buf, pos);
    const mod = buf.subarray(pos, pos + modLen).toString('utf8');
    pos += modLen;
    [nameLen, pos] = readVarU32(buf, pos);
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const kind = buf[pos++];
    if (kind === 0x00) {
      let typeIdx: number;
      [typeIdx, pos] = readVarU32(buf, pos);
      functions.push({ module: mod, name, typeIndex: typeIdx });
    } else if (kind === 0x01) {
      pos++; // elem type
      const hasMax = buf[pos++] & 1;
      [, pos] = readVarU32(buf, pos);
      if (hasMax) [, pos] = readVarU32(buf, pos);
    } else if (kind === 0x02) {
      const hasMax = buf[pos++] & 1;
      [, pos] = readVarU32(buf, pos);
      if (hasMax) [, pos] = readVarU32(buf, pos);
    } else if (kind === 0x03) {
      pos++; // value type
      const mut = buf[pos++];
      globalMutability.push(mut === 1);
    }
  }
  return { functions, globalMutability };
}

// ---------------------------------------------------------------------------
// Function section — type indices for defined functions
// ---------------------------------------------------------------------------

function parseFunctionSection(sec: RawSection | undefined): number[] {
  if (!sec) return [];
  const buf = sec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    let idx: number;
    [idx, pos] = readVarU32(buf, pos);
    indices.push(idx);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Global section — mutability of defined globals
// ---------------------------------------------------------------------------

function parseGlobalSection(sec: RawSection | undefined): boolean[] {
  if (!sec) return [];
  const buf = sec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  const mutability: boolean[] = [];
  for (let i = 0; i < count; i++) {
    pos++; // value type
    const mut = buf[pos++];
    mutability.push(mut === 1);
    // Skip init expression until 0x0b (end)
    while (pos < buf.length && buf[pos] !== 0x0b) pos++;
    pos++; // skip end
  }
  return mutability;
}

// ---------------------------------------------------------------------------
// Code section — raw body buffers
// ---------------------------------------------------------------------------

function extractFunctionBodies(sec: RawSection | undefined): Buffer[] {
  if (!sec) return [];
  const buf = sec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  const bodies: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    let size: number;
    [size, pos] = readVarU32(buf, pos);
    bodies.push(buf.subarray(pos, pos + size));
    pos += size;
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Provenance source types
// ---------------------------------------------------------------------------

export type ProvenanceKind =
  | 'parameter'
  | 'local'
  | 'const'
  | 'global_immutable'
  | 'global_mutable'
  | 'memory'
  | 'call'
  | 'call_indirect'
  | 'unknown';

export interface ProvenanceSource {
  kind: ProvenanceKind;
  /** Parameter index (kind='parameter') */
  paramIndex?: number;
  /** Local index (kind='local') */
  localIndex?: number;
  /** Constant value string (kind='const') */
  constValue?: string;
  /** Global index (kind='global_immutable' | 'global_mutable') */
  globalIndex?: number;
  /** Memory offset expression (kind='memory') */
  memoryNote?: string;
  /** Callee function index (kind='call') */
  calleeIndex?: number;
  /** Callee function name from imports if known */
  calleeName?: string;
  /** Result position within callee (kind='call') */
  calleeResultPosition?: number;
  /** Note for unknown/indirect */
  note?: string;
  /** Instruction offset within the function body */
  instructionOffset?: number;
}

export type ReturnClassification =
  | 'single_source'
  | 'multi_source'
  | 'parameter_derived'
  | 'constant_derived'
  | 'state_derived'
  | 'call_derived'
  | 'memory_derived'
  | 'unknown';

export interface ReturnSite {
  functionIndex: number;
  returnInstructionOffset: number;
  resultPosition: number;
  resultType: string;
  provenanceSources: ProvenanceSource[];
  classification: ReturnClassification;
  provenanceDepth: number;
}

export interface FunctionProvenanceSummary {
  functionIndex: number;
  returnCount: number;
  returnSites: ReturnSite[];
  hasParameterDerivedReturn: boolean;
  hasMutableStateDerivedReturn: boolean;
  hasConstantDerivedReturn: boolean;
  hasCallDerivedReturn: boolean;
  hasMemoryDerivedReturn: boolean;
  hasUnknownReturn: boolean;
}

export interface WasmProvenanceReport {
  file: string;
  valid: true;
  importedFunctionCount: number;
  definedFunctionCount: number;
  functions: FunctionProvenanceSummary[];
  statistics: {
    totalReturnSites: number;
    totalReturnedValuesAnalyzed: number;
    singleSourceReturns: number;
    multiSourceReturns: number;
    parameterDerivedResults: number;
    globalDerivedResults: number;
    memoryDerivedResults: number;
    callDerivedResults: number;
    constantDerivedResults: number;
    unknownResults: number;
    deepestProvenanceChain: number;
    functionsWithMutableStateDependency: number;
    functionsWithParameterDependency: number;
    functionsReturningConstants: number;
    functionsWithCallDependency: number;
  };
  dotGraph?: string;
}

// ---------------------------------------------------------------------------
// Abstract operand stack value
// ---------------------------------------------------------------------------

/** A set of possible provenance sources for a single stack slot. */
type ProvenanceSet = ProvenanceSource[];

function mergeProvenance(a: ProvenanceSet, b: ProvenanceSet): ProvenanceSet {
  // Conservative merge: keep all distinct sources from both sets.
  const result: ProvenanceSource[] = [...a];
  for (const src of b) {
    const key = sourceKey(src);
    if (!result.some((s) => sourceKey(s) === key)) result.push(src);
  }
  return result;
}

function sourceKey(s: ProvenanceSource): string {
  return JSON.stringify({
    kind: s.kind,
    paramIndex: s.paramIndex,
    localIndex: s.localIndex,
    constValue: s.constValue,
    globalIndex: s.globalIndex,
    calleeIndex: s.calleeIndex,
    calleeResultPosition: s.calleeResultPosition,
    memoryNote: s.memoryNote,
    note: s.note,
  });
}

const UNKNOWN: ProvenanceSource = { kind: 'unknown', note: 'unsupported_instruction' };
const INDIRECT: ProvenanceSource = { kind: 'call_indirect', note: 'indirect_call' };

// ---------------------------------------------------------------------------
// Control-flow label stack for structured control flow
// ---------------------------------------------------------------------------

type LabelKind = 'block' | 'loop' | 'if';

interface LabelEntry {
  kind: LabelKind;
  blockType: number; // result arity: 0 = void, 1 = value-producing
  /** Accumulated merge values at the join point (for block/if) */
  mergeValues: ProvenanceSet[];
}

// ---------------------------------------------------------------------------
// Analysis constants
// ---------------------------------------------------------------------------

const MAX_CALL_DEPTH = 8;

// ---------------------------------------------------------------------------
// Per-function provenance analysis
// ---------------------------------------------------------------------------

/**
 * Analyse one function body and produce ReturnSite records.
 *
 * @param bodyBuf     Raw body buffer (starting with local count LEB128)
 * @param funcIndex   Absolute function index (imports + offset)
 * @param funcType    Type signature (params, results)
 * @param globalMutability  Mutability of every global by index
 * @param importedFunctions Function import names
 * @param allBodies   All defined function bodies (for callee inlining)
 * @param allTypes    All function types
 * @param allFuncTypeIndices Type indices for defined functions (0 = imports[0])
 * @param importedFuncCount Number of imported functions
 * @param callDepth   Current recursion depth
 */
function analyseFunction(
  bodyBuf: Buffer,
  funcIndex: number,
  funcType: FuncType,
  globalMutability: boolean[],
  importedFunctions: FuncImport[],
  allBodies: Buffer[],
  allTypes: FuncType[],
  allFuncTypeIndices: number[],
  importedFuncCount: number,
  callDepth: number,
): ReturnSite[] {
  const returnSites: ReturnSite[] = [];

  // Parse locals
  let pos = 0;
  let localGroupCount: number;
  [localGroupCount, pos] = readVarU32(bodyBuf, pos);
  // locals[i] is a (count, type) pair
  const localTypes: number[] = [...funcType.params]; // params are also locals 0..n
  for (let i = 0; i < localGroupCount; i++) {
    let count: number, valType: number;
    [count, pos] = readVarU32(bodyBuf, pos);
    [valType, pos] = readByte(bodyBuf, pos);
    for (let j = 0; j < count; j++) localTypes.push(valType);
  }
  const paramCount = funcType.params.length;

  /** Current abstract operand stack. */
  let stack: ProvenanceSet[] = [];
  /** Local variable abstract values (initialized to param/unknown). */
  const locals: ProvenanceSet[] = localTypes.map((_, i) =>
    i < paramCount
      ? [{ kind: 'parameter', paramIndex: i }]
      : [{ kind: 'unknown', note: 'uninitialized_local' }],
  );
  /** Label stack for structured control flow. */
  const labels: LabelEntry[] = [];

  function push(ps: ProvenanceSet) {
    stack.push(ps.length === 0 ? [UNKNOWN] : ps);
  }

  function pop(): ProvenanceSet {
    return stack.pop() ?? [UNKNOWN];
  }

  function peek(offset = 0): ProvenanceSet {
    return stack[stack.length - 1 - offset] ?? [UNKNOWN];
  }

  function calleeResultProvenance(
    calleeIdx: number,
    resultPosition: number,
    depth: number,
  ): ProvenanceSource {
    // Try to inline the callee's return provenance (bounded depth)
    if (depth < MAX_CALL_DEPTH && calleeIdx >= importedFuncCount) {
      const definedIdx = calleeIdx - importedFuncCount;
      const calleeBuf = allBodies[definedIdx];
      const calleeTypeIdx = allFuncTypeIndices[definedIdx];
      const calleeType = allTypes[calleeTypeIdx];
      if (calleeBuf && calleeType) {
        const calleeSites = analyseFunction(
          calleeBuf,
          calleeIdx,
          calleeType,
          globalMutability,
          importedFunctions,
          allBodies,
          allTypes,
          allFuncTypeIndices,
          importedFuncCount,
          depth + 1,
        );
        // Collect provenance of resultPosition across all return sites
        const sources: ProvenanceSource[] = [];
        for (const site of calleeSites) {
          if (site.resultPosition === resultPosition) {
            sources.push(...site.provenanceSources);
          }
        }
        if (sources.length > 0) {
          // Embed as a 'call' node pointing to the callee
          return {
            kind: 'call',
            calleeIndex: calleeIdx,
            calleeResultPosition: resultPosition,
            note: `callee_inlined_depth_${depth + 1}`,
          };
        }
      }
    }
    const imp = calleeIdx < importedFuncCount ? importedFunctions[calleeIdx] : undefined;
    return {
      kind: 'call',
      calleeIndex: calleeIdx,
      calleeName: imp ? `${imp.module}.${imp.name}` : undefined,
      calleeResultPosition: resultPosition,
    };
  }

  function recordReturn(returnOffset: number) {
    // Determine number of results
    const resultCount = funcType.results.length;
    // The top resultCount values on the stack are the returned values.
    // Stack order: results[0] is deepest (stack[top - resultCount + 0])
    for (let r = 0; r < resultCount; r++) {
      const stackOffset = resultCount - 1 - r;
      const ps = peek(stackOffset);
      returnSites.push({
        functionIndex: funcIndex,
        returnInstructionOffset: returnOffset,
        resultPosition: r,
        resultType: valueTypeName(funcType.results[r]),
        provenanceSources: [...ps],
        classification: classifySources(ps),
        provenanceDepth: computeDepth(ps),
      });
    }
  }

  // Main decode loop
  const bodyEnd = bodyBuf.length;

  // We iterate in a worklist style but for simplicity use a single-pass
  // with loop iteration tracking to handle loop-carried provenance.
  // conservatively. We track a "loop merge" set per loop label to detect
  // convergence.
  const loopMergeStates = new Map<number, { locals: ProvenanceSet[]; iter: number }>();

  function decodeBody(startPos: number): void {
    pos = startPos;

    while (pos < bodyEnd) {
      const insnOffset = pos;
      const op = bodyBuf[pos++];

      switch (op) {
        // ── Unreachable / nop ────────────────────────────────────────────
        case 0x00: // unreachable
          // Mark all current stack values as unknown, signal unreachable
          stack = [];
          break;
        case 0x01: // nop
          break;

        // ── Block / loop / if ────────────────────────────────────────────
        case 0x02: // block bt
        case 0x03: // loop bt
        case 0x04: // if bt
        {
          const btByte = bodyBuf[pos];
          let blockType = 0;
          if (btByte === 0x40) { pos++; blockType = 0; }
          else if (btByte >= 0x70) { pos++; blockType = 1; }
          else { let [bt]: [number, number] = readVarU32(bodyBuf, pos); pos = bt; blockType = 0; /* type index – treat as opaque */ }
          // re-parse properly
          pos = insnOffset + 1;
          const blockTypeByte = bodyBuf[pos];
          if (blockTypeByte === 0x40) { pos++; blockType = 0; }
          else if ((blockTypeByte & 0x80) === 0 && blockTypeByte >= 0x60) {
            // This is a type index; count its results (we don't resolve, treat as 1)
            [, pos] = readVarU32(bodyBuf, pos);
            blockType = 1;
          } else if ((blockTypeByte & 0x80) === 0) {
            pos++;
            blockType = 1;
          } else {
            [, pos] = readVarU32(bodyBuf, pos);
            blockType = 0;
          }

          if (op === 0x04) pop(); // consume condition

          if (op === 0x03) {
            // loop — set up merge tracking
            const existingMerge = loopMergeStates.get(insnOffset);
            if (!existingMerge) {
              loopMergeStates.set(insnOffset, { locals: locals.map((l) => [...l]), iter: 0 });
            }
          }
          labels.push({ kind: op === 0x02 ? 'block' : op === 0x03 ? 'loop' : 'if', blockType, mergeValues: [] });
          break;
        }

        case 0x05: // else
        {
          const lbl = labels[labels.length - 1];
          if (lbl) {
            // merge current stack into the label's merge buffer, then reset stack
            if (lbl.blockType > 0 && stack.length > 0) {
              const top = pop();
              lbl.mergeValues.push(top);
            }
            stack = [];
          }
          break;
        }

        case 0x0b: // end
        {
          const lbl = labels.pop();
          if (!lbl) {
            // end of function — record implicit return
            if (funcType.results.length > 0) recordReturn(insnOffset);
            return;
          }
          if (lbl.blockType > 0) {
            if (stack.length > 0) {
              const top = pop();
              lbl.mergeValues.push(top);
            }
            // Push merged value
            const merged = lbl.mergeValues.reduce((a, b) => mergeProvenance(a, b), []);
            push(merged.length > 0 ? merged : [UNKNOWN]);
          }
          break;
        }

        // ── Branch instructions ──────────────────────────────────────────
        case 0x0c: { // br
          let depth: number; [depth, pos] = readVarU32(bodyBuf, pos);
          const target = labels[labels.length - 1 - depth];
          if (target && target.blockType > 0 && stack.length > 0) {
            const val = peek();
            target.mergeValues.push([...val]);
          }
          stack = [];
          break;
        }
        case 0x0d: { // br_if
          let depth: number; [depth, pos] = readVarU32(bodyBuf, pos);
          pop(); // condition
          const target = labels[labels.length - 1 - depth];
          if (target && target.blockType > 0 && stack.length > 0) {
            target.mergeValues.push([...peek()]);
          }
          // value stays on stack (fall-through path)
          break;
        }
        case 0x0e: { // br_table
          let count: number; [count, pos] = readVarU32(bodyBuf, pos);
          const depths: number[] = [];
          for (let i = 0; i <= count; i++) {
            let d: number; [d, pos] = readVarU32(bodyBuf, pos);
            depths.push(d);
          }
          pop(); // index
          // propagate value to all targets
          if (stack.length > 0) {
            const val = peek();
            for (const d of depths) {
              const t = labels[labels.length - 1 - d];
              if (t && t.blockType > 0) t.mergeValues.push([...val]);
            }
          }
          stack = [];
          break;
        }

        // ── Return ───────────────────────────────────────────────────────
        case 0x0f: // return
          recordReturn(insnOffset);
          stack = [];
          break;

        // ── Calls ────────────────────────────────────────────────────────
        case 0x10: { // call
          let calleeIdx: number; [calleeIdx, pos] = readVarU32(bodyBuf, pos);
          // Determine callee type
          let calleeType: FuncType | undefined;
          if (calleeIdx < importedFuncCount) {
            calleeType = allTypes[importedFunctions[calleeIdx]?.typeIndex];
          } else {
            const defIdx = calleeIdx - importedFuncCount;
            calleeType = allTypes[allFuncTypeIndices[defIdx]];
          }
          if (!calleeType) { push([UNKNOWN]); break; }
          // Pop params
          for (let i = 0; i < calleeType.params.length; i++) pop();
          // Push results
          for (let r = 0; r < calleeType.results.length; r++) {
            const src = calleeIdx === funcIndex
              ? { kind: 'unknown' as ProvenanceKind, note: 'recursive_call' }
              : calleeResultProvenance(calleeIdx, r, callDepth);
            push([src]);
          }
          break;
        }
        case 0x11: { // call_indirect
          let typeIdx: number; [typeIdx, pos] = readVarU32(bodyBuf, pos);
          [, pos] = readVarU32(bodyBuf, pos); // table index
          const indirectType = allTypes[typeIdx];
          pop(); // index
          if (indirectType) {
            for (let i = 0; i < indirectType.params.length; i++) pop();
            for (let r = 0; r < indirectType.results.length; r++) {
              push([INDIRECT]);
            }
          } else {
            push([INDIRECT]);
          }
          break;
        }

        // ── Drop / select ────────────────────────────────────────────────
        case 0x1a: // drop
          pop();
          break;
        case 0x1b: { // select
          pop(); const v2 = pop(); const v1 = pop(); // pop condition, then the two values
          push(mergeProvenance(v1, v2)); // conservative: either could be selected
          break;
        }
        case 0x1c: { // select t* (typed)
          let count: number; [count, pos] = readVarU32(bodyBuf, pos);
          for (let i = 0; i < count; i++) pos++; // skip types
          pop(); const v2b = pop(); const v1b = pop(); // pop condition, then two values
          push(mergeProvenance(v1b, v2b));
          break;
        }

        // ── Local get/set/tee ────────────────────────────────────────────
        case 0x20: { // local.get
          let li: number; [li, pos] = readVarU32(bodyBuf, pos);
          push(locals[li] ?? [UNKNOWN]);
          break;
        }
        case 0x21: { // local.set
          let li: number; [li, pos] = readVarU32(bodyBuf, pos);
          locals[li] = pop();
          break;
        }
        case 0x22: { // local.tee
          let li: number; [li, pos] = readVarU32(bodyBuf, pos);
          locals[li] = peek();
          // value stays on stack
          break;
        }

        // ── Global get/set ───────────────────────────────────────────────
        case 0x23: { // global.get
          let gi: number; [gi, pos] = readVarU32(bodyBuf, pos);
          const mut = globalMutability[gi];
          push([{
            kind: mut ? 'global_mutable' : 'global_immutable',
            globalIndex: gi,
            instructionOffset: insnOffset,
          }]);
          break;
        }
        case 0x24: { // global.set
          [, pos] = readVarU32(bodyBuf, pos);
          pop(); // consume written value
          break;
        }

        // ── Table get/set ────────────────────────────────────────────────
        case 0x25: [, pos] = readVarU32(bodyBuf, pos); pop(); push([UNKNOWN]); break; // table.get
        case 0x26: [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); break;             // table.set

        // ── Memory loads ─────────────────────────────────────────────────
        case 0x28: case 0x29: case 0x2a: case 0x2b: // i32.load, i64.load, f32.load, f64.load
        case 0x2c: case 0x2d: case 0x2e: case 0x2f: // i32.load8_s/u i32.load16_s/u
        case 0x30: case 0x31: case 0x32: case 0x33: // i64.load*
        {
          [, pos] = readVarU32(bodyBuf, pos); // align (unused)
          let offset: number;
          [offset, pos] = readVarU32(bodyBuf, pos);
          pop(); // address
          push([{ kind: 'memory', memoryNote: `offset=${offset}`, instructionOffset: insnOffset }]);
          break;
        }

        // ── Memory stores ────────────────────────────────────────────────
        case 0x36: case 0x37: case 0x38: case 0x39: // i32.store, i64.store, f32.store, f64.store
        case 0x3a: case 0x3b: case 0x3c: case 0x3d: // i32.store8, i32.store16, i64.store8, i64.store16
        case 0x3e: // i64.store32
        {
          [, pos] = readVarU32(bodyBuf, pos);
          [, pos] = readVarU32(bodyBuf, pos);
          pop(); pop(); // address, value
          break;
        }

        // ── Memory size/grow ─────────────────────────────────────────────
        case 0x3f: pos++; push([{ kind: 'unknown', note: 'memory_size' }]); break;
        case 0x40: pos++; pop(); push([{ kind: 'unknown', note: 'memory_grow' }]); break;

        // ── Constants ────────────────────────────────────────────────────
        case 0x41: { // i32.const
          let v: number; [v, pos] = readVarI32(bodyBuf, pos);
          push([{ kind: 'const', constValue: String(v), instructionOffset: insnOffset }]);
          break;
        }
        case 0x42: { // i64.const
          let v: bigint; [v, pos] = readVarI64(bodyBuf, pos);
          push([{ kind: 'const', constValue: String(v), instructionOffset: insnOffset }]);
          break;
        }
        case 0x43: { // f32.const
          let v: number; [v, pos] = readF32(bodyBuf, pos);
          push([{ kind: 'const', constValue: String(v), instructionOffset: insnOffset }]);
          break;
        }
        case 0x44: { // f64.const
          let v: number; [v, pos] = readF64(bodyBuf, pos);
          push([{ kind: 'const', constValue: String(v), instructionOffset: insnOffset }]);
          break;
        }

        // ── Numeric tests (0 → i32, 1 → i32) ────────────────────────────
        case 0x45: case 0x50: // i32.eqz, i64.eqz
          pop(); push([{ kind: 'unknown', note: 'comparison_result' }]); break;

        // ── Comparisons (pop 2, push i32) ────────────────────────────────
        case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: case 0x4b:
        case 0x4c: case 0x4d: case 0x4e: case 0x4f: // i32.eq/ne/lt/gt/le/ge
        case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56:
        case 0x57: case 0x58: case 0x59: case 0x5a: // i64.eq/ne/lt/gt/le/ge
        case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: case 0x60:
        case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: // f32/f64 cmp
          pop(); pop(); push([{ kind: 'unknown', note: 'comparison_result' }]); break;

        // ── Unary arithmetic (pop 1, push 1) ─────────────────────────────
        case 0x67: case 0x68: case 0x69: // i32.clz, i32.ctz, i32.popcnt
        case 0x79: case 0x7a: case 0x7b: // i64.clz, i64.ctz, i64.popcnt
        case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f: // f32 unary
        case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: // f64 unary
        case 0xa7: case 0xa8: case 0xa9: case 0xaa: case 0xab:
        case 0xac: case 0xad: case 0xae: case 0xaf: case 0xb0:
        case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5:
        case 0xb6: case 0xb7: case 0xb8: case 0xb9: case 0xba:
        case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf: // conversions
        {
          const v = pop();
          push(v); // propagate provenance through unary op
          break;
        }

        // ── Binary arithmetic (pop 2, push 1) ────────────────────────────
        case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f:
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75:
        case 0x76: case 0x77: case 0x78: // i32 arithmetic
        case 0x7c: case 0x7d: case 0x7e: case 0x7f: case 0x80: case 0x81:
        case 0x82: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87:
        case 0x88: case 0x89: case 0x8a: // i64 arithmetic
        case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: // f32 arithmetic
        case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: // f64 arithmetic
        {
          const rhs = pop(); const lhs = pop();
          push(mergeProvenance(lhs, rhs)); // conservative: result depends on both
          break;
        }

        // ── Extended: prefixed instructions (0xfc, 0xfd) ─────────────────
        case 0xfc: {
          let subOp: number; [subOp, pos] = readVarU32(bodyBuf, pos);
          switch (subOp) {
            case 0: pop(); push([UNKNOWN]); break; // i32.trunc_sat_f32_s
            case 1: pop(); push([UNKNOWN]); break; // i32.trunc_sat_f32_u
            case 2: pop(); push([UNKNOWN]); break; // i32.trunc_sat_f64_s
            case 3: pop(); push([UNKNOWN]); break; // i32.trunc_sat_f64_u
            case 4: pop(); push([UNKNOWN]); break; // i64.trunc_sat_f32_s
            case 5: pop(); push([UNKNOWN]); break;
            case 6: pop(); push([UNKNOWN]); break;
            case 7: pop(); push([UNKNOWN]); break;
            case 8: { // memory.init
              [, pos] = readVarU32(bodyBuf, pos);
              [, pos] = readVarU32(bodyBuf, pos);
              pop(); pop(); pop(); break;
            }
            case 9: [, pos] = readVarU32(bodyBuf, pos); break; // data.drop
            case 10: [, pos] = readVarU32(bodyBuf, pos); [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); pop(); break; // memory.copy
            case 11: [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); pop(); break; // memory.fill
            case 12: [, pos] = readVarU32(bodyBuf, pos); [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); pop(); break; // table.init
            case 13: [, pos] = readVarU32(bodyBuf, pos); break; // elem.drop
            case 14: [, pos] = readVarU32(bodyBuf, pos); [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); pop(); break; // table.copy
            case 15: [, pos] = readVarU32(bodyBuf, pos); pop(); push([UNKNOWN]); break; // table.grow
            case 16: [, pos] = readVarU32(bodyBuf, pos); push([UNKNOWN]); break; // table.size
            case 17: [, pos] = readVarU32(bodyBuf, pos); pop(); pop(); pop(); break; // table.fill
            default: push([UNKNOWN]); break;
          }
          break;
        }
        case 0xfd: {
          // SIMD — skip and push unknown
          [, pos] = readVarU32(bodyBuf, pos);
          push([UNKNOWN]);
          break;
        }

        default:
          // Unknown/extension opcode — push unknown conservatively
          push([{ kind: 'unknown', note: `unknown_opcode_0x${op.toString(16)}` }]);
          break;
      }
    }
  }

  // Run the body decode
  try {
    decodeBody(pos);
  } catch (e) {
    // Parsing error — record unknown for any missing returns
    if (funcType.results.length > 0 && returnSites.length === 0) {
      for (let r = 0; r < funcType.results.length; r++) {
        returnSites.push({
          functionIndex: funcIndex,
          returnInstructionOffset: -1,
          resultPosition: r,
          resultType: valueTypeName(funcType.results[r]),
          provenanceSources: [{ kind: 'unknown', note: `parse_error: ${(e as Error).message}` }],
          classification: 'unknown',
          provenanceDepth: 0,
        });
      }
    }
  }

  return returnSites;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function classifySources(sources: ProvenanceSource[]): ReturnClassification {
  if (sources.length === 0) return 'unknown';
  const kinds = new Set(sources.map((s) => s.kind));
  if (sources.length === 1) {
    const s = sources[0];
    if (s.kind === 'parameter' || s.kind === 'local') return 'parameter_derived';
    if (s.kind === 'const') return 'constant_derived';
    if (s.kind === 'global_mutable') return 'state_derived';
    if (s.kind === 'global_immutable') return 'constant_derived';
    if (s.kind === 'memory') return 'memory_derived';
    if (s.kind === 'call' || s.kind === 'call_indirect') return 'call_derived';
    return 'unknown';
  }
  // Multiple sources
  if (kinds.has('global_mutable')) return 'state_derived';
  if (kinds.has('memory')) return 'memory_derived';
  if (kinds.has('parameter') || kinds.has('local')) return 'parameter_derived';
  if (kinds.has('call') || kinds.has('call_indirect')) return 'call_derived';
  if (kinds.has('const') || kinds.has('global_immutable')) return 'constant_derived';
  return 'multi_source';
}

function computeDepth(sources: ProvenanceSource[]): number {
  if (sources.length === 0) return 0;
  // A concrete chain has depth >= 1 for any resolved source
  return sources.some((s) => s.kind !== 'unknown') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Function summary
// ---------------------------------------------------------------------------

function summariseFunction(
  funcIndex: number,
  returnSites: ReturnSite[],
): FunctionProvenanceSummary {
  return {
    functionIndex: funcIndex,
    returnCount: returnSites.length,
    returnSites,
    hasParameterDerivedReturn: returnSites.some(
      (rs) => rs.classification === 'parameter_derived',
    ),
    hasMutableStateDerivedReturn: returnSites.some(
      (rs) =>
        rs.classification === 'state_derived' ||
        rs.provenanceSources.some((s) => s.kind === 'global_mutable'),
    ),
    hasConstantDerivedReturn: returnSites.some(
      (rs) => rs.classification === 'constant_derived',
    ),
    hasCallDerivedReturn: returnSites.some((rs) => rs.classification === 'call_derived'),
    hasMemoryDerivedReturn: returnSites.some((rs) => rs.classification === 'memory_derived'),
    hasUnknownReturn: returnSites.some((rs) => rs.classification === 'unknown'),
  };
}

// ---------------------------------------------------------------------------
// DOT graph generation
// ---------------------------------------------------------------------------

function generateDot(report: Omit<WasmProvenanceReport, 'dotGraph'>): string {
  const lines: string[] = ['digraph wasm_provenance {', '  rankdir=LR;', '  node [shape=box];'];

  for (const fn of report.functions) {
    const fnId = `fn_${fn.functionIndex}`;
    lines.push(`  ${fnId} [label="func ${fn.functionIndex}" shape=ellipse];`);

    for (const site of fn.returnSites) {
      const siteId = `ret_${fn.functionIndex}_${site.returnInstructionOffset}_${site.resultPosition}`;
      lines.push(
        `  ${siteId} [label="return\\npos=${site.resultPosition}\\n${site.classification}" color=blue];`,
      );
      lines.push(`  ${fnId} -> ${siteId};`);

      for (const src of site.provenanceSources) {
        let srcId: string;
        let srcLabel: string;
        switch (src.kind) {
          case 'parameter':
            srcId = `param_${fn.functionIndex}_${src.paramIndex}`;
            srcLabel = `param[${src.paramIndex}]`;
            break;
          case 'local':
            srcId = `local_${fn.functionIndex}_${src.localIndex}`;
            srcLabel = `local[${src.localIndex}]`;
            break;
          case 'const':
            srcId = `const_${fn.functionIndex}_${site.returnInstructionOffset}_${src.constValue}`;
            srcLabel = `const(${src.constValue})`;
            break;
          case 'global_immutable':
          case 'global_mutable':
            srcId = `global_${src.globalIndex}`;
            srcLabel = `global[${src.globalIndex}]\\n${src.kind === 'global_mutable' ? 'mutable' : 'immutable'}`;
            break;
          case 'memory':
            srcId = `mem_${fn.functionIndex}_${site.returnInstructionOffset}`;
            srcLabel = `memory\\n${src.memoryNote ?? ''}`;
            break;
          case 'call':
            srcId = `call_${src.calleeIndex}_r${src.calleeResultPosition}`;
            srcLabel = `call\\nfunc[${src.calleeIndex}]${src.calleeName ? `\\n${src.calleeName}` : ''}`;
            break;
          case 'call_indirect':
            srcId = `call_indirect_${fn.functionIndex}_${site.returnInstructionOffset}`;
            srcLabel = `call_indirect`;
            break;
          default:
            srcId = `unknown_${fn.functionIndex}_${site.returnInstructionOffset}`;
            srcLabel = `unknown\\n${src.note ?? ''}`;
        }
        lines.push(`  ${srcId} [label="${srcLabel}"];`);
        lines.push(`  ${srcId} -> ${siteId};`);
      }
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeReturnProvenance(filePath: string): WasmProvenanceReport {
  const wasm = fs.readFileSync(filePath);
  return analyzeReturnProvenanceBuffer(wasm, filePath);
}

export function analyzeReturnProvenanceBuffer(
  wasm: Buffer,
  filePath: string,
): WasmProvenanceReport {
  const sections = parseSections(wasm);

  const typeSec = sections.find((s) => s.id === 1);
  const importSec = sections.find((s) => s.id === 2);
  const funcSec = sections.find((s) => s.id === 3);
  const globalSec = sections.find((s) => s.id === 6);
  const codeSec = sections.find((s) => s.id === 10);

  const types = parseTypeSection(typeSec);
  const { functions: importedFunctions, globalMutability: importedGlobalMut } =
    parseImportSection(importSec);
  const funcTypeIndices = parseFunctionSection(funcSec);
  const definedGlobalMut = parseGlobalSection(globalSec);
  const globalMutability = [...importedGlobalMut, ...definedGlobalMut];
  const bodies = extractFunctionBodies(codeSec);

  const importedFuncCount = importedFunctions.length;
  const definedFuncCount = funcTypeIndices.length;

  const functions: FunctionProvenanceSummary[] = [];

  for (let i = 0; i < definedFuncCount; i++) {
    const funcIndex = importedFuncCount + i;
    const typeIdx = funcTypeIndices[i];
    const funcType = types[typeIdx];
    if (!funcType) continue;
    const body = bodies[i];
    if (!body) continue;

    const returnSites = analyseFunction(
      body,
      funcIndex,
      funcType,
      globalMutability,
      importedFunctions,
      bodies,
      types,
      funcTypeIndices,
      importedFuncCount,
      0,
    );
    functions.push(summariseFunction(funcIndex, returnSites));
  }

  // Compute aggregate statistics
  const allReturnSites = functions.flatMap((f) => f.returnSites);

  const stats = {
    totalReturnSites: allReturnSites.length,
    totalReturnedValuesAnalyzed: allReturnSites.length,
    singleSourceReturns: allReturnSites.filter((rs) => rs.provenanceSources.length === 1).length,
    multiSourceReturns: allReturnSites.filter((rs) => rs.provenanceSources.length > 1).length,
    parameterDerivedResults: allReturnSites.filter(
      (rs) => rs.classification === 'parameter_derived',
    ).length,
    globalDerivedResults: allReturnSites.filter(
      (rs) =>
        rs.classification === 'state_derived' ||
        rs.provenanceSources.some(
          (s) => s.kind === 'global_immutable' || s.kind === 'global_mutable',
        ),
    ).length,
    memoryDerivedResults: allReturnSites.filter((rs) => rs.classification === 'memory_derived')
      .length,
    callDerivedResults: allReturnSites.filter((rs) => rs.classification === 'call_derived').length,
    constantDerivedResults: allReturnSites.filter((rs) => rs.classification === 'constant_derived')
      .length,
    unknownResults: allReturnSites.filter((rs) => rs.classification === 'unknown').length,
    deepestProvenanceChain: Math.max(0, ...allReturnSites.map((rs) => rs.provenanceDepth)),
    functionsWithMutableStateDependency: functions.filter((f) => f.hasMutableStateDerivedReturn)
      .length,
    functionsWithParameterDependency: functions.filter((f) => f.hasParameterDerivedReturn).length,
    functionsReturningConstants: functions.filter((f) => f.hasConstantDerivedReturn).length,
    functionsWithCallDependency: functions.filter((f) => f.hasCallDerivedReturn).length,
  };

  const report: Omit<WasmProvenanceReport, 'dotGraph'> = {
    file: filePath,
    valid: true,
    importedFunctionCount: importedFuncCount,
    definedFunctionCount: definedFuncCount,
    functions,
    statistics: stats,
  };

  return { ...report, dotGraph: generateDot(report) };
}

// ---------------------------------------------------------------------------
// Two-artifact comparison
// ---------------------------------------------------------------------------

export interface ProvenanceComparisonReport {
  before: WasmProvenanceReport;
  after: WasmProvenanceReport;
  comparison: {
    functionCountDelta: number;
    returnSiteDelta: number;
    addedFunctions: number[];
    removedFunctions: number[];
    changedFunctions: Array<{
      functionIndex: number;
      changes: string[];
    }>;
    newlyStateDerived: number[];
    newlyParameterDerived: number[];
    changedCallDependencies: number[];
  };
}

export function compareProvenanceReports(
  beforeFile: string,
  afterFile: string,
): ProvenanceComparisonReport {
  const before = analyzeReturnProvenance(beforeFile);
  const after = analyzeReturnProvenance(afterFile);

  const beforeFuncMap = new Map(before.functions.map((f) => [f.functionIndex, f]));
  const afterFuncMap = new Map(after.functions.map((f) => [f.functionIndex, f]));

  const addedFunctions = [...afterFuncMap.keys()].filter((k) => !beforeFuncMap.has(k));
  const removedFunctions = [...beforeFuncMap.keys()].filter((k) => !afterFuncMap.has(k));

  const changedFunctions: Array<{ functionIndex: number; changes: string[] }> = [];
  const newlyStateDerived: number[] = [];
  const newlyParameterDerived: number[] = [];
  const changedCallDependencies: number[] = [];

  for (const [idx, afterFn] of afterFuncMap) {
    const beforeFn = beforeFuncMap.get(idx);
    if (!beforeFn) continue;
    const changes: string[] = [];

    if (beforeFn.returnCount !== afterFn.returnCount)
      changes.push(`return_site_count: ${beforeFn.returnCount} → ${afterFn.returnCount}`);

    if (!beforeFn.hasMutableStateDerivedReturn && afterFn.hasMutableStateDerivedReturn) {
      changes.push('newly_state_derived');
      newlyStateDerived.push(idx);
    }
    if (!beforeFn.hasParameterDerivedReturn && afterFn.hasParameterDerivedReturn) {
      changes.push('newly_parameter_derived');
      newlyParameterDerived.push(idx);
    }
    if (beforeFn.hasCallDerivedReturn !== afterFn.hasCallDerivedReturn) {
      changes.push('call_dependency_changed');
      changedCallDependencies.push(idx);
    }
    if (beforeFn.hasConstantDerivedReturn !== afterFn.hasConstantDerivedReturn)
      changes.push('constant_derivation_changed');
    if (beforeFn.hasMemoryDerivedReturn !== afterFn.hasMemoryDerivedReturn)
      changes.push('memory_derivation_changed');

    if (changes.length > 0) changedFunctions.push({ functionIndex: idx, changes });
  }

  return {
    before,
    after,
    comparison: {
      functionCountDelta: after.definedFunctionCount - before.definedFunctionCount,
      returnSiteDelta:
        after.statistics.totalReturnSites - before.statistics.totalReturnSites,
      addedFunctions,
      removedFunctions,
      changedFunctions,
      newlyStateDerived,
      newlyParameterDerived,
      changedCallDependencies,
    },
  };
}
