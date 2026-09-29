/**
 * Soroban Contract WASM Memory Alias Analysis Example
 * 
 * Parses WASM binaries, extracts memory loads and stores, classifies effective addresses,
 * performs alias analysis, detects conflicts, and supports filtering, statistics, JSON/CSV output,
 * and dual-artifact comparison.
 */

const fs = require('fs');

function parseWasm(buffer) {
  if (buffer.length < 8 || buffer.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('Invalid WASM binary magic header');
  }
  
  let offset = 8;
  const functions = [];
  const codeBodies = [];
  
  while (offset < buffer.length) {
    const sectionId = buffer[offset];
    offset += 1;
    
    const [sectionSize, bytesRead] = readVarUint32(buffer, offset);
    offset += bytesRead;
    const sectionEnd = offset + sectionSize;
    
    if (sectionId === 3) {
      // Function section
      const [count, bRead] = readVarUint32(buffer, offset);
      let curr = offset + bRead;
      for (let i = 0; i < count; i++) {
        const [typeIdx, br] = readVarUint32(buffer, curr);
        curr += br;
        functions.push({ funcIndex: functions.length, typeIndex: typeIdx });
      }
    } else if (sectionId === 10) {
      // Code section
      const [count, bRead] = readVarUint32(buffer, offset);
      let curr = offset + bRead;
      for (let i = 0; i < count; i++) {
        const [bodySize, br] = readVarUint32(buffer, curr);
        curr += br;
        const bodyEnd = curr + bodySize;
        
        const [localCount, lbr] = readVarUint32(buffer, curr);
        curr += lbr;
        // skip locals
        for (let l = 0; l < localCount; l++) {
          const [, lcountBr] = readVarUint32(buffer, curr);
          curr += lcountBr;
          curr += 1; // type
        }
        
        const codeBytes = buffer.subarray(curr, bodyEnd);
        codeBodies.push(codeBytes);
        curr = bodyEnd;
      }
    }
    
    offset = sectionEnd;
  }
  
  return { functions, codeBodies };
}

function readVarUint32(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, bytesRead];
}

function analyzeAccesses(codeBodies) {
  const accesses = [];
  
  codeBodies.forEach((body, funcIndex) => {
    let pc = 0;
    let basicBlock = 0;
    let instIndex = 0;
    
    // Simplified heuristic extraction for loads/stores in WASM bytecode
    while (pc < body.length) {
      const opcode = body[pc];
      pc++;
      instIndex++;
      
      // Basic block boundary heuristics (e.g., br, br_if, end)
      if (opcode === 0x0b || opcode === 0x0c || opcode === 0x0d) {
        basicBlock++;
      }
      
      // Load opcodes: 0x28 - 0x3f, Store opcodes: 0x3a - 0x3f (approximate ranges)
      let accessType = null;
      if (opcode >= 0x28 && opcode <= 0x35) {
        accessType = 'load';
      } else if (opcode >= 0x36 && opcode <= 0x3f) {
        accessType = 'store';
      }
      
      if (accessType) {
        const [align, b1] = readVarUint32(bufferSafe(body, pc), 0);
        pc += b1;
        const [staticOffset, b2] = readVarUint32(bufferSafe(body, pc), 0);
        pc += b2;
        
        const width = getAccessWidth(opcode);
        
        accesses.push({
          funcIndex,
          basicBlock,
          instIndex,
          accessType,
          accessWidth: width,
          alignment: align,
          staticOffset,
          memoryIndex: 0,
          classification: staticOffset !== undefined ? 'exact' : 'unknown',
          addressExpr: `base + ${staticOffset}`
        });
      }
    }
  });
  
  return accesses;
}

function bufferSafe(body, pc) {
  return body.subarray(pc);
}

function getAccessWidth(opcode) {
  // 8, 16, 32, 64-bit widths based on load/store variant
  switch (opcode) {
    case 0x28: case 0x36: return 32;
    case 0x29: case 0x37: return 64;
    case 0x2a: case 0x38: return 32;
    case 0x2b: case 0x39: return 32;
    case 0x2c: case 0x3a: return 16;
    case 0x2d: case 0x3b: return 16;
    case 0x2e: case 0x3c: return 8;
    case 0x2f: case 0x3d: return 8;
    default: return 32;
  }
}

function compareAccesses(acc1, acc2) {
  if (acc1.funcIndex !== acc2.funcIndex) return 'unknown';
  
  if (acc1.classification === 'exact' && acc2.classification === 'exact') {
    const range1 = [acc1.staticOffset, acc1.staticOffset + (acc1.accessWidth / 8)];
    const range2 = [acc2.staticOffset, acc2.staticOffset + (acc2.accessWidth / 8)];
    
    if (range1[0] === range2[0] && range1[1] === range2[1]) {
      return 'must-alias';
    }
    if (range1[1] <= range2[0] || range2[1] <= range1[0]) {
      return 'no-alias';
    }
    return 'may-alias';
  }
  
  return 'unknown';
}

function analyzeAliases(accesses) {
  const pairs = [];
  let mustAliasCount = 0;
  let mayAliasCount = 0;
  let noAliasCount = 0;
  let unknownCount = 0;
  let conflicts = 0;
  
  const funcMap = {};
  
  for (let i = 0; i < accesses.length; i++) {
    for (let j = i + 1; j < accesses.length; j++) {
      const a = accesses[i];
      const b = accesses[j];
      const relation = compareAccesses(a, b);
      
      pairs.push({ a, b, relation });
      
      if (relation === 'must-alias') mustAliasCount++;
      else if (relation === 'may-alias') {
        mayAliasCount++;
        if ((a.accessType === 'store' || b.accessType === 'store') && a.accessType !== b.accessType) {
          conflicts++;
        }
      } else if (relation === 'no-alias') noAliasCount++;
      else unknownCount++;
      
      const fKey = `func_${a.funcIndex}`;
      funcMap[fKey] = (funcMap[fKey] || 0) + 1;
    }
  }
  
  let maxAliasDensity = 0;
  Object.values(funcMap).forEach(val => {
    if (val > maxAliasDensity) maxAliasDensity = val;
  });
  
  return {
    pairs,
    stats: {
      totalAccesses: accesses.length,
      totalPairsCompared: pairs.length,
      mustAliasPairs: mustAliasCount,
      mayAliasPairs: mayAliasCount,
      noAliasPairs: noAliasCount,
      unknownRelationships: unknownCount,
      potentialConflicts: conflicts,
      maxAliasDensity
    }
  };
}

function compareArtifacts(res1, res2) {
  const keyOf = (p) => `${p.a.funcIndex}:${p.a.instIndex}-${p.b.funcIndex}:${p.b.instIndex}`;
  const map1 = new Map(res1.pairs.map(p => [keyOf(p), p.relation]));
  const map2 = new Map(res2.pairs.map(p => [keyOf(p), p.relation]));
  
  const added = [];
  const removed = [];
  const changed = [];
  
  map2.forEach((rel2, k) => {
    if (!map1.has(k)) added.push({ pairKey: k, relation: rel2 });
    else if (map1.get(k) !== rel2) changed.push({ pairKey: k, oldRelation: map1.get(k), newRelation: rel2 });
  });
  
  map1.forEach((rel1, k) => {
    if (!map2.has(k)) removed.push({ pairKey: k, relation: rel1 });
  });
  
  return { added, removed, changed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node wasm-memory-alias.js <wasmFile> [--compare <wasmFile2>] [--json] [--csv]');
    process.exit(1);
  }
  
  const wasmFile1 = args[0];
  let wasmFile2 = null;
  let jsonMode = args.includes('--json');
  let csvMode = args.includes('--csv');
  
  const compIdx = args.indexOf('--compare');
  if (compIdx !== -1 && args[compIdx + 1]) {
    wasmFile2 = args[compIdx + 1];
  }
  
  const buf1 = fs.readFileSync(wasmFile1);
  const parsed1 = parseWasm(buf1);
  const accs1 = analyzeAccesses(parsed1.codeBodies);
  const res1 = analyzeAliases(accs1);
  
  let compResult = null;
  if (wasmFile2) {
    const buf2 = fs.readFileSync(wasmFile2);
    const parsed2 = parseWasm(buf2);
    const accs2 = analyzeAccesses(parsed2.codeBodies);
    const res2 = analyzeAliases(accs2);
    compResult = compareArtifacts(res1, res2);
  }
  
  if (jsonMode) {
    console.log(JSON.stringify({ stats: res1.stats, pairs: res1.pairs, comparison: compResult }, null, 2));
  } else if (csvMode) {
    console.log('FuncA,InstA,TypeA,FuncB,InstB,TypeB,Relation');
    res1.pairs.forEach(p => {
      console.log(`${p.a.funcIndex},${p.a.instIndex},${p.a.accessType},${p.b.funcIndex},${p.b.instIndex},${p.b.accessType},${p.relation}`);
    });
  } else {
    console.log('=== Soroban WASM Memory Alias Analysis ===');
    console.log(`Total Accesses Analyzed: ${res1.stats.totalAccesses}`);
    console.log(`Total Access Pairs Compared: ${res1.stats.totalPairsCompared}`);
    console.log(`Must-Alias Pairs: ${res1.stats.mustAliasPairs}`);
    console.log(`May-Alias Pairs: ${res1.stats.mayAliasPairs}`);
    console.log(`No-Alias Pairs: ${res1.stats.noAliasPairs}`);
    console.log(`Unknown Relationships: ${res1.stats.unknownRelationships}`);
    console.log(`Potential Read/Write Conflicts: ${res1.stats.potentialConflicts}`);
    console.log(`Maximum Alias Density: ${res1.stats.maxAliasDensity}`);
    
    if (compResult) {
      console.log('\
=== Artifact Comparison ===');
      console.log(`Added Alias Relationships: ${compResult.added.length}`);
      console.log(`Removed Alias Relationships: ${compResult.removed.length}`);
      console.log(`Changed Alias Classifications: ${compResult.changed.length}`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseWasm, analyzeAccesses, analyzeAliases, compareArtifacts };
