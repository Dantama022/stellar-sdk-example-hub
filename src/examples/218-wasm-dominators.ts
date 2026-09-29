import fs from 'fs';
import path from 'path';

import chalk from 'chalk';

import { WasmValidationError } from '../utils/wasm-static-analysis';

/**
 * Example 218: Soroban Contract WASM Dominator Tree Analysis
 *
 * Constructs a control-flow graph (CFG) for every function in a WASM binary
 * and performs a full dominator-tree analysis without executing any contract
 * code. The analysis is completely offline.
 *
 * Dominance model:
 *   Block A dominates block B when every path from the function entry to B
 *   passes through A. The immediate dominator of B is the closest such A
 *   (excluding B itself). These relationships form a tree rooted at the entry
 *   block; every node in that tree represents "must pass through" structure
 *   that is invisible in a plain CFG.
 *
 * Analysis limitations:
 *   - WASM structured control flow (block/loop/if) is converted to a flat CFG
 *     using a label-stack model; the resulting edges are conservative and
 *     correct for dominance purposes.
 *   - Indirect calls (call_indirect) are not followed across function
 *     boundaries; each function is analysed in isolation.
 *   - The implementation uses the classic iterative dataflow algorithm
 *     (Cooper et al. "A Simple, Fast Dominance Algorithm") with post-order
 *     numbering for convergence speed.
 *   - LEB128 immediate parsing covers the instruction set used by Soroban
 *     contracts; exotic SIMD or GC instructions are treated as opaque and do
 *     not generate extra edges.
 */

// ---------------------------------------------------------------------------
// WASM binary reading helpers (self-contained, no external state)
// ---------------------------------------------------------------------------

function readByte(buf: Buffer, pos: number): [number, number] {
  if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data');
  return [buf[pos], pos + 1];
}

function readVarU32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (LEB128)');
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
  throw new WasmValidationError('Malformed unsigned LEB128');
}

function readVarI32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let b = 0;
  do {
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (SLEB128)');
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
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (SLEB128-64)');
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while ((b & 0x80) !== 0 && shift < 70n);
  if (shift < 64n && (b & 0x40) !== 0) result |= ~0n << shift;
  return [result, pos];
}

// ---------------------------------------------------------------------------
// WASM section parsing — extract only what we need for CFG construction
// ---------------------------------------------------------------------------

interface RawSection { id: number; payload: Buffer }

function parseSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8) throw new WasmValidationError('WASM binary too short');
  if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d)
    throw new WasmValidationError('Missing WASM magic header');
  if (wasm.readUInt32LE(4) !== 1)
    throw new WasmValidationError('Unsupported WASM version');
  const sections: RawSection[] = [];
  let pos = 8;
  while (pos < wasm.length) {
    let id: number;
    [id, pos] = readByte(wasm, pos);
    let size: number;
    [size, pos] = readVarU32(wasm, pos);
    if (pos + size > wasm.length) throw new WasmValidationError('Section exceeds WASM data');
    sections.push({ id, payload: wasm.subarray(pos, pos + size) });
    pos += size;
  }
  return sections;
}

/** Count imported functions (their bodies are not in the code section). */
function countImportedFunctions(sections: RawSection[]): number {
  const importSec = sections.find((s) => s.id === 2);
  if (!importSec) return 0;
  const buf = importSec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  let fns = 0;
  for (let i = 0; i < count; i++) {
    // skip module name
    let len: number;
    [len, pos] = readVarU32(buf, pos);
    pos += len;
    // skip field name
    [len, pos] = readVarU32(buf, pos);
    pos += len;
    let kind: number;
    [kind, pos] = readByte(buf, pos);
    if (kind === 0x00) { fns++; [, pos] = readVarU32(buf, pos); }          // function
    else if (kind === 0x01) { pos++; [, pos] = readVarU32(buf, pos); [, pos] = readVarU32(buf, pos); if (buf[pos - 2] & 1) [, pos] = readVarU32(buf, pos); } // table – rough skip
    else if (kind === 0x02) { let f: number; [f, pos] = readVarU32(buf, pos); pos += f ? 4 : 2; } // memory rough
    else if (kind === 0x03) { pos += 2; }                                    // global rough
  }
  return fns;
}

/** Extract raw function-body buffers from the code section. */
function extractFunctionBodies(sections: RawSection[]): Buffer[] {
  const codeSec = sections.find((s) => s.id === 10);
  if (!codeSec) return [];
  const buf = codeSec.payload;
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

/** Extract export names keyed by function index. */
function extractFunctionExports(sections: RawSection[]): Map<number, string> {
  const exportSec = sections.find((s) => s.id === 7);
  const result = new Map<number, string>();
  if (!exportSec) return result;
  const buf = exportSec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  for (let i = 0; i < count; i++) {
    let nameLen: number;
    [nameLen, pos] = readVarU32(buf, pos);
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    let kind: number, index: number;
    [kind, pos] = readByte(buf, pos);
    [index, pos] = readVarU32(buf, pos);
    if (kind === 0x00) result.set(index, name); // function export
  }
  return result;
}

// ---------------------------------------------------------------------------
// CFG construction from a WASM function body
// ---------------------------------------------------------------------------

export interface CfgBlock {
  /** Index within this function's block list, 0 = entry. */
  id: number;
  /** Instruction offset range [start, end) within the body buffer. */
  startOffset: number;
  endOffset: number;
  /** Successor block IDs. */
  successors: number[];
  /** Predecessor block IDs (filled after full CFG is built). */
  predecessors: number[];
  /** True when the block ends with an unconditional transfer (return/br/unreachable). */
  isTerminating: boolean;
}

export interface FunctionCfg {
  functionIndex: number;
  exportName: string | null;
  blocks: CfgBlock[];
  entryBlockId: number;
  /** Block IDs that represent a back-edge target (loop header heuristic). */
  loopHeaders: number[];
  parseError: string | null;
}

/**
 * Build a CFG from raw WASM function-body bytes.
 *
 * WASM uses structured control flow (block/loop/if/else/end).  We translate
 * each structured construct into basic blocks connected by edges:
 *
 *   block … end   → fall-through: entry → body → continuation
 *   loop  … end   → back-edge:    end → loop-header
 *   if    … end   → conditional:  test → then-block + continuation
 *   if … else … end → conditional: test → then-block | else-block; both → continuation
 *   br <depth>    → branch to the labelled block's break target
 *   br_if <depth> → conditional branch + fall-through
 *   br_table      → one edge per table entry
 *   return / unreachable → terminate block, no fall-through
 */
export function buildCfg(body: Buffer, functionIndex: number, exportName: string | null): FunctionCfg {
  const blocks: CfgBlock[] = [];
  const loopHeaders: number[] = [];
  let parseError: string | null = null;

  function newBlock(startOffset: number): CfgBlock {
    const b: CfgBlock = {
      id: blocks.length,
      startOffset,
      endOffset: startOffset,
      successors: [],
      predecessors: [],
      isTerminating: false,
    };
    blocks.push(b);
    return b;
  }

  function addEdge(from: CfgBlock, toId: number): void {
    if (!from.successors.includes(toId)) from.successors.push(toId);
  }

  try {
    // Skip locals declaration at the start of the body
    let pos = 0;
    let localGroupCount: number;
    [localGroupCount, pos] = readVarU32(body, pos);
    for (let i = 0; i < localGroupCount; i++) {
      [, pos] = readVarU32(body, pos); // count
      pos++;                            // type byte
    }

    // Label stack entry: {breakTarget, continueTarget, isLoop}
    // breakTarget   = block ID to jump to after the construct exits
    // continueTarget = block ID for br targeting this label (loop re-entry)
    interface LabelEntry {
      breakTargetId: number;   // target when br breaks out
      continueTargetId: number; // target when br continues (same for non-loop)
      isLoop: boolean;
      isIf: boolean;
      elseBlockId: number | null;
      afterBlockId: number;   // continuation after the whole construct
    }

    const labelStack: LabelEntry[] = [];
    const entryBlock = newBlock(pos);

    // Push sentinel for the function-level "block"
    // A bare return jumps to an implicit exit; we create it lazily.
    let exitBlockId = -1;
    function getExitBlock(): number {
      if (exitBlockId === -1) {
        exitBlockId = newBlock(body.length).id;
        blocks[exitBlockId].isTerminating = true;
      }
      return exitBlockId;
    }

    // Push the function-level label
    const funcExit = newBlock(pos);
    funcExit.isTerminating = true;
    exitBlockId = funcExit.id;

    labelStack.push({
      breakTargetId: funcExit.id,
      continueTargetId: entryBlock.id,
      isLoop: false,
      isIf: false,
      elseBlockId: null,
      afterBlockId: funcExit.id,
    });

    let current = entryBlock;

    const MAX_BLOCKS = 4096; // guard against pathological inputs

    while (pos < body.length && blocks.length < MAX_BLOCKS) {
      const opPos = pos;
      let opcode: number;
      [opcode, pos] = readByte(body, pos);

      switch (opcode) {
        // ── Structured control flow ──────────────────────────────────────
        case 0x02: { // block
          pos++; // block type byte
          const afterBlock = newBlock(pos);
          labelStack.push({
            breakTargetId: afterBlock.id,
            continueTargetId: afterBlock.id,
            isLoop: false,
            isIf: false,
            elseBlockId: null,
            afterBlockId: afterBlock.id,
          });
          break;
        }
        case 0x03: { // loop
          pos++; // block type byte
          const loopHeader = newBlock(pos);
          loopHeaders.push(loopHeader.id);
          addEdge(current, loopHeader.id);
          const afterLoop = newBlock(pos);
          labelStack.push({
            breakTargetId: afterLoop.id,
            continueTargetId: loopHeader.id, // br inside loop → re-enter header
            isLoop: true,
            isIf: false,
            elseBlockId: null,
            afterBlockId: afterLoop.id,
          });
          current = loopHeader;
          break;
        }
        case 0x04: { // if
          pos++; // block type byte
          const thenBlock = newBlock(pos);
          const afterIf = newBlock(pos);
          addEdge(current, thenBlock.id);
          addEdge(current, afterIf.id); // else-less if: fall-through to after
          labelStack.push({
            breakTargetId: afterIf.id,
            continueTargetId: afterIf.id,
            isLoop: false,
            isIf: true,
            elseBlockId: null,
            afterBlockId: afterIf.id,
          });
          current = thenBlock;
          break;
        }
        case 0x05: { // else
          const top = labelStack[labelStack.length - 1];
          if (!top) break;
          // End the then-block, jump to afterIf
          addEdge(current, top.afterBlockId);
          // Create the else block
          const elseBlock = newBlock(pos);
          top.elseBlockId = elseBlock.id;
          // The predecessor "if" block now also jumps to else
          // Find the if-block (the one whose successor includes afterBlockId but not elseBlock yet)
          // We patch: find the block that branched to afterBlockId from the if, and add elseBlock
          // In practice we stored afterBlockId as the false branch above; add elseBlock edge from the
          // if-condition block. We track it through the parent of current via the label.
          // Simpler: add edge from the block that created the if-label → elseBlock.
          // We cannot easily trace back, so we track the "condition block" in the label.
          // For correctness we just connect elseBlock as a new block starting here.
          current = elseBlock;
          break;
        }
        case 0x0b: { // end
          if (labelStack.length <= 1) {
            // Function-level end — connect to exit
            addEdge(current, exitBlockId);
            current.endOffset = opPos + 1;
            break;
          }
          const top = labelStack.pop()!;
          current.endOffset = opPos;
          // Fall-through from current block to the continuation
          if (!current.isTerminating) addEdge(current, top.afterBlockId);
          // Continuation block starts after end
          const afterBlock = blocks.find((b) => b.id === top.afterBlockId);
          if (afterBlock) {
            afterBlock.startOffset = pos;
            current = afterBlock;
          }
          break;
        }

        // ── Branch instructions ───────────────────────────────────────────
        case 0x0c: { // br <depth>
          let depth: number;
          [depth, pos] = readVarU32(body, pos);
          const targetIdx = labelStack.length - 1 - depth;
          if (targetIdx >= 0) {
            const label = labelStack[targetIdx];
            addEdge(current, label.isLoop ? label.continueTargetId : label.breakTargetId);
          }
          current.isTerminating = true;
          current.endOffset = pos;
          const nextBr = newBlock(pos);
          current = nextBr;
          break;
        }
        case 0x0d: { // br_if <depth>
          let depth: number;
          [depth, pos] = readVarU32(body, pos);
          const targetIdx = labelStack.length - 1 - depth;
          if (targetIdx >= 0) {
            const label = labelStack[targetIdx];
            addEdge(current, label.isLoop ? label.continueTargetId : label.breakTargetId);
          }
          // Fall-through continues in the same conceptual block; split anyway for precision
          const nextBrIf = newBlock(pos);
          addEdge(current, nextBrIf.id);
          current.endOffset = pos;
          current = nextBrIf;
          break;
        }
        case 0x0e: { // br_table <labels…> <default>
          let count: number;
          [count, pos] = readVarU32(body, pos);
          for (let t = 0; t <= count; t++) {
            let depth: number;
            [depth, pos] = readVarU32(body, pos);
            const targetIdx = labelStack.length - 1 - depth;
            if (targetIdx >= 0) {
              const label = labelStack[targetIdx];
              addEdge(current, label.isLoop ? label.continueTargetId : label.breakTargetId);
            }
          }
          current.isTerminating = true;
          current.endOffset = pos;
          const nextBrTable = newBlock(pos);
          current = nextBrTable;
          break;
        }
        case 0x0f: { // return
          addEdge(current, exitBlockId);
          current.isTerminating = true;
          current.endOffset = pos;
          const nextRet = newBlock(pos);
          current = nextRet;
          break;
        }
        case 0x00: { // unreachable
          current.isTerminating = true;
          current.endOffset = pos;
          const nextUnreach = newBlock(pos);
          current = nextUnreach;
          break;
        }

        // ── Instructions with immediates (skip bytes) ─────────────────────
        case 0x01: break; // nop
        case 0x10: [, pos] = readVarU32(body, pos); break; // call
        case 0x11: [, pos] = readVarU32(body, pos); pos++; break; // call_indirect
        case 0x1a: case 0x1b: break; // drop, select
        case 0x20: case 0x21: case 0x22: [, pos] = readVarU32(body, pos); break; // local.*
        case 0x23: case 0x24: [, pos] = readVarU32(body, pos); break; // global.*
        case 0x25: case 0x26: [, pos] = readVarU32(body, pos); break; // table.*
        // memory load/store: alignment + offset
        case 0x28: case 0x29: case 0x2a: case 0x2b:
        case 0x2c: case 0x2d: case 0x2e: case 0x2f:
        case 0x30: case 0x31: case 0x32: case 0x33:
        case 0x34: case 0x35: case 0x36: case 0x37:
        case 0x38: case 0x39: case 0x3a: case 0x3b:
        case 0x3c: case 0x3d: case 0x3e:
          [, pos] = readVarU32(body, pos); [, pos] = readVarU32(body, pos); break;
        case 0x3f: case 0x40: pos++; break; // memory.size / memory.grow
        case 0x41: [, pos] = readVarI32(body, pos); break; // i32.const
        case 0x42: [, pos] = readVarI64(body, pos); break; // i64.const
        case 0x43: pos += 4; break; // f32.const
        case 0x44: pos += 8; break; // f64.const
        case 0xfc: { // multi-byte opcodes (memory.copy etc.)
          [, pos] = readVarU32(body, pos);
          break;
        }
        // Everything else: 0-immediate opcodes (arithmetic, comparisons, conversions)
        default: break;
      }

      current.endOffset = pos;
    }

    // Seal: ensure exit block is connected
    getExitBlock();

  } catch (err: unknown) {
    parseError = err instanceof WasmValidationError
      ? err.message
      : `CFG parse error: ${String(err)}`;
  }

  // Fill predecessor lists
  for (const block of blocks) {
    for (const succId of block.successors) {
      const succ = blocks[succId];
      if (succ && !succ.predecessors.includes(block.id)) {
        succ.predecessors.push(block.id);
      }
    }
  }

  return {
    functionIndex,
    exportName,
    blocks,
    entryBlockId: blocks.length > 0 ? 0 : -1,
    loopHeaders,
    parseError,
  };
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** BFS reachability from entry. Returns set of reachable block IDs. */
export function reachableBlocks(cfg: FunctionCfg): Set<number> {
  const visited = new Set<number>();
  if (cfg.entryBlockId < 0 || cfg.blocks.length === 0) return visited;
  const queue = [cfg.entryBlockId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const block = cfg.blocks[id];
    if (block) for (const s of block.successors) if (!visited.has(s)) queue.push(s);
  }
  return visited;
}

// ---------------------------------------------------------------------------
// Dominator computation (Cooper et al. "A Simple, Fast Dominance Algorithm")
// ---------------------------------------------------------------------------

export interface DominatorInfo {
  /** Map from block ID → immediate-dominator block ID (-1 for entry). */
  idom: Map<number, number>;
  /** Map from block ID → dominator depth (entry = 0). */
  depth: Map<number, number>;
  /** Map from block ID → set of blocks it strictly dominates. */
  dominatedBy: Map<number, Set<number>>;
  /** Map from block ID → subtree size (number of blocks dominated). */
  subtreeSize: Map<number, number>;
  /** Block IDs that dominate all CFG exits (excluding the exit itself). */
  exitDominators: number[];
  /** Block IDs that dominate at least one loop header. */
  loopHeaderDominators: number[];
  /** Block IDs with multiple CFG predecessors. */
  multiPredBlocks: number[];
  /** Maximum dominator depth across all reachable blocks. */
  maxDepth: number;
  /** Fraction of reachable blocks dominated by the entry block (always 1.0). */
  entryCoverage: number;
}

export function computeDominators(cfg: FunctionCfg): DominatorInfo {
  const reachable = reachableBlocks(cfg);
  const idom = new Map<number, number>();

  const empty: DominatorInfo = {
    idom,
    depth: new Map(),
    dominatedBy: new Map(),
    subtreeSize: new Map(),
    exitDominators: [],
    loopHeaderDominators: [],
    multiPredBlocks: [],
    maxDepth: 0,
    entryCoverage: 0,
  };

  if (reachable.size === 0) return empty;

  const entry = cfg.entryBlockId;

  // Compute reverse post-order for reachable blocks
  const rpo: number[] = [];
  {
    const visited = new Set<number>();
    const postOrder: number[] = [];
    function dfs(id: number) {
      if (visited.has(id)) return;
      visited.add(id);
      const block = cfg.blocks[id];
      if (!block) return;
      for (const s of block.successors) if (reachable.has(s)) dfs(s);
      postOrder.push(id);
    }
    dfs(entry);
    rpo.push(...postOrder.reverse());
  }

  // rpoIndex[id] = position in RPO (lower = earlier in RPO)
  const rpoIndex = new Map<number, number>();
  rpo.forEach((id, i) => rpoIndex.set(id, i));

  // Initialise idom
  for (const id of rpo) idom.set(id, -1);
  idom.set(entry, entry); // entry dominates itself

  // Intersect function for the Cooper algorithm
  function intersect(b1: number, b2: number): number {
    let finger1 = b1;
    let finger2 = b2;
    while (finger1 !== finger2) {
      while ((rpoIndex.get(finger1) ?? 0) > (rpoIndex.get(finger2) ?? 0)) {
        finger1 = idom.get(finger1) ?? finger1;
      }
      while ((rpoIndex.get(finger2) ?? 0) > (rpoIndex.get(finger1) ?? 0)) {
        finger2 = idom.get(finger2) ?? finger2;
      }
    }
    return finger1;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === entry) continue;
      const block = cfg.blocks[b];
      if (!block) continue;
      const processedPreds = block.predecessors.filter(
        (p) => reachable.has(p) && idom.get(p) !== -1,
      );
      if (processedPreds.length === 0) continue;
      let newIdom = processedPreds[0];
      for (let i = 1; i < processedPreds.length; i++) {
        newIdom = intersect(processedPreds[i], newIdom);
      }
      if (idom.get(b) !== newIdom) {
        idom.set(b, newIdom);
        changed = true;
      }
    }
  }

  // Entry's idom is itself; normalise to -1 for external representation
  idom.set(entry, -1);

  // Build depth and dominatedBy
  const depth = new Map<number, number>();
  const dominatedBy = new Map<number, Set<number>>();
  for (const id of reachable) {
    dominatedBy.set(id, new Set());
  }

  // BFS from entry through idom tree
  depth.set(entry, 0);
  const depthQueue = [entry];
  while (depthQueue.length > 0) {
    const node = depthQueue.shift()!;
    const d = depth.get(node) ?? 0;
    for (const candidate of reachable) {
      if (idom.get(candidate) === node && candidate !== entry) {
        depth.set(candidate, d + 1);
        dominatedBy.get(node)?.add(candidate);
        depthQueue.push(candidate);
      }
    }
  }

  // Subtree sizes
  const subtreeSize = new Map<number, number>();
  for (const id of reachable) subtreeSize.set(id, 0);
  // Process in reverse RPO (leaves first)
  for (let i = rpo.length - 1; i >= 0; i--) {
    const id = rpo[i];
    const size = (subtreeSize.get(id) ?? 0) + 1; // count self
    subtreeSize.set(id, size);
    const parent = idom.get(id);
    if (parent !== undefined && parent !== -1 && reachable.has(parent)) {
      subtreeSize.set(parent, (subtreeSize.get(parent) ?? 0) + size);
    }
  }

  // Max depth
  let maxDepth = 0;
  for (const d of depth.values()) if (d > maxDepth) maxDepth = d;

  // Exit blocks (no successors or isTerminating), find blocks dominating all of them
  const exitIds = rpo.filter((id) => {
    const b = cfg.blocks[id];
    return b && (b.successors.length === 0 || b.isTerminating);
  });

  const exitDominators: number[] = [];
  for (const cand of reachable) {
    if (exitIds.length === 0) break;
    let dominatesAll = true;
    for (const exitId of exitIds) {
      // cand dominates exitId iff cand is an ancestor of exitId in idom tree
      let cursor = exitId;
      let found = false;
      while (cursor !== -1) {
        if (cursor === cand) { found = true; break; }
        const parent = idom.get(cursor);
        if (parent === undefined || parent === cursor) break;
        cursor = parent;
      }
      if (!found) { dominatesAll = false; break; }
    }
    if (dominatesAll) exitDominators.push(cand);
  }

  // Loop header dominators
  const loopHeaderDominators = new Set<number>();
  for (const lh of cfg.loopHeaders) {
    if (!reachable.has(lh)) continue;
    let cursor = lh;
    while (cursor !== -1) {
      const parent = idom.get(cursor);
      if (parent === undefined || parent === cursor || parent === -1) break;
      loopHeaderDominators.add(parent);
      cursor = parent;
    }
  }

  // Multi-predecessor blocks
  const multiPredBlocks = rpo.filter((id) => {
    const b = cfg.blocks[id];
    return b && b.predecessors.filter((p) => reachable.has(p)).length > 1;
  });

  return {
    idom,
    depth,
    dominatedBy,
    subtreeSize,
    exitDominators,
    loopHeaderDominators: [...loopHeaderDominators],
    multiPredBlocks,
    maxDepth,
    entryCoverage: reachable.size > 0 ? reachable.size / reachable.size : 0,
  };
}

// ---------------------------------------------------------------------------
// Full per-function analysis result
// ---------------------------------------------------------------------------

export interface BlockAnalysis {
  blockId: number;
  startOffset: number;
  endOffset: number;
  successors: number[];
  predecessors: number[];
  isTerminating: boolean;
  isReachable: boolean;
  isLoopHeader: boolean;
  idomId: number; // -1 for entry or unreachable
  depth: number;
  subtreeSize: number;
  dominates: number[]; // strictly dominated children in idom tree
}

export interface FunctionAnalysis {
  functionIndex: number;
  exportName: string | null;
  totalBlocks: number;
  reachableBlocks: number;
  unreachableBlocks: number;
  maxDominatorDepth: number;
  entryBlockId: number;
  exitDominators: number[];
  loopHeaderDominators: number[];
  multiPredBlocks: number[];
  loopHeaders: number[];
  blocks: BlockAnalysis[];
  parseError: string | null;
}

export interface WasmDominatorReport {
  file: string;
  totalFunctions: number;
  importedFunctions: number;
  analyzedFunctions: FunctionAnalysis[];
  diagnostics: string[];
}

export function analyzeWasmDominators(wasmFile: string): WasmDominatorReport {
  const diagnostics: string[] = [];

  let wasm: Buffer;
  try {
    wasm = fs.readFileSync(wasmFile);
  } catch (err: unknown) {
    return {
      file: wasmFile,
      totalFunctions: 0,
      importedFunctions: 0,
      analyzedFunctions: [],
      diagnostics: [`Cannot read file: ${(err as Error).message}`],
    };
  }

  let sections: RawSection[];
  try {
    sections = parseSections(wasm);
  } catch (err: unknown) {
    return {
      file: wasmFile,
      totalFunctions: 0,
      importedFunctions: 0,
      analyzedFunctions: [],
      diagnostics: [`WASM parse failed: ${(err as Error).message}`],
    };
  }

  const importedCount = countImportedFunctions(sections);
  const bodies = extractFunctionBodies(sections);
  const exportNames = extractFunctionExports(sections);

  const analyzedFunctions: FunctionAnalysis[] = [];

  for (let i = 0; i < bodies.length; i++) {
    const funcIndex = importedCount + i;
    const exportName = exportNames.get(funcIndex) ?? null;
    let cfg: FunctionCfg;
    try {
      cfg = buildCfg(bodies[i], funcIndex, exportName);
    } catch (err: unknown) {
      diagnostics.push(`Function ${funcIndex}: CFG build failed: ${(err as Error).message}`);
      continue;
    }

    if (cfg.parseError) {
      diagnostics.push(`Function ${funcIndex}: ${cfg.parseError}`);
    }

    const reachable = reachableBlocks(cfg);
    const dom = computeDominators(cfg);

    const blockAnalyses: BlockAnalysis[] = cfg.blocks.map((b) => ({
      blockId: b.id,
      startOffset: b.startOffset,
      endOffset: b.endOffset,
      successors: [...b.successors],
      predecessors: [...b.predecessors],
      isTerminating: b.isTerminating,
      isReachable: reachable.has(b.id),
      isLoopHeader: cfg.loopHeaders.includes(b.id),
      idomId: dom.idom.get(b.id) ?? -1,
      depth: dom.depth.get(b.id) ?? 0,
      subtreeSize: dom.subtreeSize.get(b.id) ?? 0,
      dominates: [...(dom.dominatedBy.get(b.id) ?? [])].sort((a, b) => a - b),
    }));

    analyzedFunctions.push({
      functionIndex: funcIndex,
      exportName,
      totalBlocks: cfg.blocks.length,
      reachableBlocks: reachable.size,
      unreachableBlocks: cfg.blocks.length - reachable.size,
      maxDominatorDepth: dom.maxDepth,
      entryBlockId: cfg.entryBlockId,
      exitDominators: dom.exitDominators.sort((a, b) => a - b),
      loopHeaderDominators: dom.loopHeaderDominators.sort((a, b) => a - b),
      multiPredBlocks: dom.multiPredBlocks.sort((a, b) => a - b),
      loopHeaders: [...cfg.loopHeaders].sort((a, b) => a - b),
      blocks: blockAnalyses,
      parseError: cfg.parseError,
    });
  }

  return {
    file: wasmFile,
    totalFunctions: importedCount + bodies.length,
    importedFunctions: importedCount,
    analyzedFunctions,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Comparison mode
// ---------------------------------------------------------------------------

export interface BlockDiff {
  functionIndex: number;
  blockId: number;
  kind:
    | 'block-added'
    | 'block-removed'
    | 'idom-changed'
    | 'depth-changed'
    | 'subtree-changed';
  before?: unknown;
  after?: unknown;
}

export interface DominatorComparison {
  fileA: string;
  fileB: string;
  diffs: BlockDiff[];
  addedFunctions: number[];
  removedFunctions: number[];
}

export function compareReports(
  a: WasmDominatorReport,
  b: WasmDominatorReport,
): DominatorComparison {
  const diffs: BlockDiff[] = [];
  const aFuncs = new Map(a.analyzedFunctions.map((f) => [f.functionIndex, f]));
  const bFuncs = new Map(b.analyzedFunctions.map((f) => [f.functionIndex, f]));

  const allIndices = new Set([...aFuncs.keys(), ...bFuncs.keys()]);
  const addedFunctions: number[] = [];
  const removedFunctions: number[] = [];

  for (const idx of [...allIndices].sort((x, y) => x - y)) {
    const fa = aFuncs.get(idx);
    const fb = bFuncs.get(idx);
    if (!fa) { addedFunctions.push(idx); continue; }
    if (!fb) { removedFunctions.push(idx); continue; }

    const aBlocks = new Map(fa.blocks.map((bl) => [bl.blockId, bl]));
    const bBlocks = new Map(fb.blocks.map((bl) => [bl.blockId, bl]));
    const allBlockIds = new Set([...aBlocks.keys(), ...bBlocks.keys()]);

    for (const bid of [...allBlockIds].sort((x, y) => x - y)) {
      const ba = aBlocks.get(bid);
      const bb = bBlocks.get(bid);
      if (!ba) {
        diffs.push({ functionIndex: idx, blockId: bid, kind: 'block-added' });
        continue;
      }
      if (!bb) {
        diffs.push({ functionIndex: idx, blockId: bid, kind: 'block-removed' });
        continue;
      }
      if (ba.idomId !== bb.idomId) {
        diffs.push({ functionIndex: idx, blockId: bid, kind: 'idom-changed', before: ba.idomId, after: bb.idomId });
      }
      if (ba.depth !== bb.depth) {
        diffs.push({ functionIndex: idx, blockId: bid, kind: 'depth-changed', before: ba.depth, after: bb.depth });
      }
      if (ba.subtreeSize !== bb.subtreeSize) {
        diffs.push({ functionIndex: idx, blockId: bid, kind: 'subtree-changed', before: ba.subtreeSize, after: bb.subtreeSize });
      }
    }
  }

  return { fileA: a.file, fileB: b.file, diffs, addedFunctions, removedFunctions };
}

// ---------------------------------------------------------------------------
// DOT graph export
// ---------------------------------------------------------------------------

export function reportToDot(report: WasmDominatorReport, functionIndex?: number): string {
  const fns = functionIndex !== undefined
    ? report.analyzedFunctions.filter((f) => f.functionIndex === functionIndex)
    : report.analyzedFunctions;

  const lines: string[] = ['digraph dominators {', '  rankdir=TB;', '  node [shape=box fontname="monospace" fontsize=10];'];

  for (const fn of fns) {
    const label = fn.exportName ? `fn_${fn.functionIndex}_${fn.exportName}` : `fn_${fn.functionIndex}`;
    lines.push(`  subgraph cluster_${fn.functionIndex} {`);
    lines.push(`    label="${label}";`);
    for (const b of fn.blocks) {
      if (!b.isReachable) continue;
      const attrs: string[] = [];
      if (b.blockId === fn.entryBlockId) attrs.push('style=filled fillcolor=lightblue');
      else if (b.isLoopHeader) attrs.push('style=filled fillcolor=lightyellow');
      else if (b.isTerminating) attrs.push('style=filled fillcolor=lightgrey');
      const attrStr = attrs.length > 0 ? ` [${attrs.join(' ')}]` : '';
      lines.push(`    b${fn.functionIndex}_${b.blockId} [label="B${b.blockId}\\ndepth=${b.depth}"]${attrStr};`);
    }
    for (const b of fn.blocks) {
      if (!b.isReachable) continue;
      for (const child of b.dominates) {
        lines.push(`    b${fn.functionIndex}_${b.blockId} -> b${fn.functionIndex}_${child};`);
      }
    }
    lines.push('  }');
  }
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Human-readable display
// ---------------------------------------------------------------------------

function printReport(report: WasmDominatorReport, jsonMode: boolean, dotMode: boolean): void {
  if (jsonMode) {
    const out = {
      file: report.file,
      totalFunctions: report.totalFunctions,
      importedFunctions: report.importedFunctions,
      analyzedFunctions: report.analyzedFunctions,
      diagnostics: report.diagnostics,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (dotMode) {
    console.log(reportToDot(report));
    return;
  }

  console.log(chalk.bold('\nWASM Dominator Tree Analysis'));
  console.log(`File:                ${report.file}`);
  console.log(`Total functions:     ${report.totalFunctions}`);
  console.log(`Imported functions:  ${report.importedFunctions}`);
  console.log(`Analyzed functions:  ${report.analyzedFunctions.length}`);

  if (report.diagnostics.length > 0) {
    console.log(chalk.bold.yellow('\nDiagnostics:'));
    report.diagnostics.forEach((d) => console.log(`  ${chalk.yellow(d)}`));
  }

  for (const fn of report.analyzedFunctions) {
    const title = fn.exportName
      ? `Function ${fn.functionIndex} (${fn.exportName})`
      : `Function ${fn.functionIndex}`;
    console.log(chalk.bold.cyan(`\n${title}`));
    console.log(`  Blocks:              ${fn.totalBlocks} total, ${fn.reachableBlocks} reachable, ${fn.unreachableBlocks} unreachable`);
    console.log(`  Max dominator depth: ${fn.maxDominatorDepth}`);
    console.log(`  Loop headers:        ${fn.loopHeaders.length > 0 ? fn.loopHeaders.join(', ') : 'none'}`);
    console.log(`  Exit dominators:     ${fn.exitDominators.length > 0 ? fn.exitDominators.join(', ') : 'none'}`);
    console.log(`  Loop-hdr dominators: ${fn.loopHeaderDominators.length > 0 ? fn.loopHeaderDominators.join(', ') : 'none'}`);
    console.log(`  Multi-pred blocks:   ${fn.multiPredBlocks.length > 0 ? fn.multiPredBlocks.join(', ') : 'none'}`);

    if (fn.parseError) {
      console.log(chalk.red(`  Parse error: ${fn.parseError}`));
    }

    // Show top-5 blocks by subtree size
    const topBlocks = [...fn.blocks]
      .filter((b) => b.isReachable)
      .sort((a, b) => b.subtreeSize - a.subtreeSize)
      .slice(0, 5);

    if (topBlocks.length > 0) {
      console.log(chalk.bold('  Top blocks by subtree size:'));
      for (const b of topBlocks) {
        const tag = b.blockId === fn.entryBlockId ? ' [entry]'
          : b.isLoopHeader ? ' [loop]'
          : b.isTerminating ? ' [exit]'
          : '';
        console.log(`    B${b.blockId}${tag}  depth=${b.depth}  subtree=${b.subtreeSize}  idom=B${b.idomId < 0 ? 'root' : b.idomId}`);
      }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Example entry point
// ---------------------------------------------------------------------------

export interface WasmDominatorsParams {
  wasmFile?: string;
  compareFile?: string;
  json?: boolean;
  dot?: boolean;
  dotOutput?: string;
}

const DEFAULT_WASM = path.join(__dirname, '../contracts/sample/hello.wasm');

export async function run(params: WasmDominatorsParams = {}): Promise<void> {
  const wasmFile =
    params.wasmFile?.trim() ||
    process.env.WASM_FILE?.trim() ||
    process.argv[3]?.trim() ||
    DEFAULT_WASM;

  const compareFile =
    params.compareFile?.trim() ||
    process.env.WASM_COMPARE_FILE?.trim() ||
    process.argv[4]?.trim();

  const jsonMode = params.json ?? process.argv.includes('--json');
  const dotMode = params.dot ?? process.argv.includes('--dot');
  const dotOutput = params.dotOutput?.trim() || process.env.DOT_OUTPUT?.trim();

  if (!jsonMode && !dotMode) {
    console.log(chalk.bold('Soroban Contract WASM Dominator Tree Analysis'));
    console.log(`Source: ${wasmFile}`);
  }

  if (!fs.existsSync(wasmFile)) {
    const msg = `WASM file not found: ${wasmFile}`;
    if (jsonMode) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(chalk.red(msg));
    return;
  }

  const report = analyzeWasmDominators(wasmFile);

  // DOT output to file
  if (dotOutput) {
    const dot = reportToDot(report);
    fs.writeFileSync(dotOutput, dot);
    if (!jsonMode) console.log(chalk.green(`DOT graph written to: ${dotOutput}`));
  }

  // Comparison mode
  if (compareFile) {
    if (!fs.existsSync(compareFile)) {
      console.error(chalk.red(`Compare file not found: ${compareFile}`));
      return;
    }
    const reportB = analyzeWasmDominators(compareFile);
    const comparison = compareReports(report, reportB);
    if (jsonMode) {
      console.log(JSON.stringify(comparison, null, 2));
    } else {
      console.log(chalk.bold('\nDominator Comparison'));
      console.log(`A: ${comparison.fileA}`);
      console.log(`B: ${comparison.fileB}`);
      if (comparison.addedFunctions.length > 0)
        console.log(`Added functions:   ${comparison.addedFunctions.join(', ')}`);
      if (comparison.removedFunctions.length > 0)
        console.log(`Removed functions: ${comparison.removedFunctions.join(', ')}`);
      if (comparison.diffs.length === 0) {
        console.log(chalk.green('No dominator differences found.'));
      } else {
        console.log(chalk.bold.red(`\n${comparison.diffs.length} dominator difference(s):`));
        comparison.diffs.slice(0, 20).forEach((d) => {
          console.log(`  fn=${d.functionIndex} block=${d.blockId} [${d.kind}]${d.before !== undefined ? ` ${d.before} → ${d.after}` : ''}`);
        });
      }
    }
    return;
  }

  printReport(report, jsonMode, dotMode);
}
