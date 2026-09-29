/**
 * WASM Operand Stack Type Analysis Example for Soroban Contracts
 * Analyzes WASM bytecode statically to verify operand stack types, control flow, and detect inconsistencies.
 */

const fs = require('fs');
const path = require('path');

const VAL_TYPES = {
  0x7F: 'i32',
  0x7E: 'i64',
  0x7D: 'f32',
  0x7C: 'f64',
  0x70: 'funcref',
  0x6F: 'externref'
};

const OPCODES = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x02: 'block',
  0x03: 'loop',
  0x04: 'if',
  0x05: 'else',
  0x0B: 'end',
  0x0C: 'br',
  0x0D: 'br_if',
  0x0E: 'br_table',
  0x0F: 'return',
  0x10: 'call',
  0x1A: 'drop',
  0x1B: 'select',
  0x20: 'local.get',
  0x21: 'local.set',
  0x22: 'local.tee',
  0x23: 'global.get',
  0x24: 'global.set',
  0x41: 'i32.const',
  0x42: 'i64.const',
  0x6A: 'i32.add',
  0x6B: 'i32.sub',
  0x7C: 'i64.add',
  0x7D: 'i64.sub'
};

function parseWasmLeb128(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    result |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, bytesRead };
}

function parseWasm(buffer) {
  if (buffer.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('Invalid WASM magic number');
  }
  const version = buffer.readUInt32LE(4);
  let offset = 8;
  const sections = [];

  while (offset < buffer.length) {
    const id = buffer[offset];
    offset++;
    const { value: size, bytesRead } = parseWasmLeb128(buffer, offset);
    offset += bytesRead;
    const sectionData = buffer.slice(offset, offset + size);
    sections.push({ id, data: sectionData });
    offset += size;
  }
  return { version, sections };
}

function analyzeFunctionBody(funcIndex, codeBytes, types) {
  let offset = 0;
  const { value: localCount, bytesRead } = parseWasmLeb128(codeBytes, offset);
  offset += bytesRead;

  for (let i = 0; i < localCount; i++) {
    const { value: count, bytesRead: b1 } = parseWasmLeb128(codeBytes, offset);
    offset += b1;
    const typeByte = codeBytes[offset];
    offset += 1;
  }

  const instructions = [];
  let blockDepth = 0;
  let stack = [];
  let maxStackDepth = 0;
  let inconsistencies = 0;
  let merges = 0;
  let polymorphicStates = 0;

  while (offset < codeBytes.length) {
    const opcode = codeBytes[offset];
    const opName = OPCODES[opcode] || `unknown_0x${opcode.toString(16)}`;
    offset++;

    let inputTypes = [];
    let outputTypes = [];

    if (opcode === 0x41) {
      // i32.const
      const { bytesRead: b } = parseWasmLeb128(codeBytes, offset);
      offset += b;
      outputTypes = ['i32'];
    } else if (opcode === 0x42) {
      // i64.const
      const { bytesRead: b } = parseWasmLeb128(codeBytes, offset);
      offset += b;
      outputTypes = ['i64'];
    } else if (opcode === 0x6A || opcode === 0x6B) {
      // i32 binops
      inputTypes = ['i32', 'i32'];
      outputTypes = ['i32'];
    } else if (opcode === 0x1A) {
      // drop
      if (stack.length > 0) {
        inputTypes = [stack[stack.length - 1]];
      } else {
        inconsistencies++;
        inputTypes = ['unknown'];
      }
    } else if (opcode === 0x0B) {
      // end
      blockDepth = Math.max(0, blockDepth - 1);
    } else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      // block, loop, if
      blockDepth++;
    }

    // Update simulated stack
    for (const inp of inputTypes) {
      if (stack.length === 0) {
        inconsistencies++;
      } else {
        stack.pop();
      }
    }
    for (const out of outputTypes) {
      stack.push(out);
    }

    if (stack.length > maxStackDepth) {
      maxStackDepth = stack.length;
    }

    instructions.push({
      functionIndex: funcIndex,
      basicBlock: blockDepth,
      instructionIndex: instructions.length,
      opcode: opName,
      inputTypes,
      outputTypes,
      stackState: [...stack]
    });
  }

  return {
    functionIndex: funcIndex,
    instructions,
    metrics: {
      maxStackDepth,
      maxTypedStackSize: maxStackDepth,
      merges,
      polymorphicStates,
      inconsistencies
    }
  };
}

function analyzeWasmFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parsed = parseWasm(buffer);

  const codeSection = parsed.sections.find(s => s.id === 10);
  const results = [];

  if (codeSection) {
    let offset = 0;
    const { value: funcCount, bytesRead } = parseWasmLeb128(codeSection.data, offset);
    offset += bytesRead;

    let bodyOffsets = [];
    for (let i = 0; i < funcCount; i++) {
      const { value: bodySize, bytesRead: b } = parseWasmLeb128(codeSection.data, offset);
      offset += b;
      bodyOffsets.push({ offset, size: bodySize });
      offset += bodySize;
    }

    bodyOffsets.forEach((bInfo, idx) => {
      const codeBytes = codeSection.data.slice(bInfo.offset, bInfo.offset + bInfo.size);
      const analysis = analyzeFunctionBody(idx, codeBytes);
      results.push(analysis);
    });
  }

  return results;
}

function compareArtifacts(artifactA, artifactB) {
  const resultsA = analyzeWasmFile(artifactA);
  const resultsB = analyzeWasmFile(artifactB);

  return {
    comparison: 'Artifact stack analysis diff',
    artifactA: path.basename(artifactA),
    artifactB: path.basename(artifactB),
    functionsCompared: Math.max(resultsA.length, resultsB.length),
    changesDetected: resultsA.length !== resultsB.length
  };
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const csvMode = args.includes('--csv');
  const compareIndex = args.indexOf('--compare');

  const targetFiles = args.filter(arg => !arg.startsWith('--'));
  if (targetFiles.length === 0) {
    console.error('Usage: node wasm-stack-types.js <wasmFile> [--json] [--csv] [--compare <otherWasm>]');
    process.exit(1);
  }

  if (compareIndex !== -1 && targetFiles.length >= 2) {
    const diff = compareArtifacts(targetFiles[0], targetFiles[1]);
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  const analysis = analyzeWasmFile(targetFiles[0]);

  if (jsonMode) {
    console.log(JSON.stringify(analysis, null, 2));
  } else if (csvMode) {
    console.log('functionIndex,basicBlock,instructionIndex,opcode,inputTypes,outputTypes');
    analysis.forEach(fn => {
      fn.instructions.forEach(ins => {
        console.log(`${ins.functionIndex},${ins.basicBlock},${ins.instructionIndex},${ins.opcode},"${ins.inputTypes.join(';')}","${ins.outputTypes.join(';')}"`);
      });
    });
  } else {
    console.log(JSON.stringify(analysis, null, 2));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseWasm,
  analyzeWasmFile,
  compareArtifacts
};
