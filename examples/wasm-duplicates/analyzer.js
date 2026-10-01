const { readWasmModule } = require('fast-wasi');

class WasmAnalyzer {
  constructor(options = {}) {
    this.options = {
      minSize: 0,
      exactOnly: false,
      includeNormalized: false,
      similarityThreshold: 95,
      normalizeMetadata: true,
      ...options
    };
  }

  async analyze(wasmBuffer) {
    const module = await readWasmModule(wasmBuffer);
    const codeSection = module.code || [];
    const functions = codeSection.map((code, index) => ({
      index,
      body: code.body || new Uint8Array(),
      size: code.body ? code.body.length : 0
    }));

    const filteredFunctions = functions.filter(f => f.size >= this.options.minSize);
    const { groups, stats } = this.detectDuplicates(filteredFunctions);

    return {
      totalFunctions: functions.length,
      uniqueFunctions: stats.uniqueFunctions,
      duplicateGroups: stats.duplicateGroups,
      duplicatedFunctions: stats.duplicatedFunctions,
      largestGroupSize: stats.largestGroupSize,
      duplicateCodePercentage: stats.duplicateCodePercentage,
      duplicatedInstructionCount: stats.duplicatedInstructionCount,
      groups
    };
  }

  detectDuplicates(functions) {
    const groups = [];
    const seen = new Set();
    let uniqueCount = 0;
    let duplicatedCount = 0;
    let largestGroup = 0;
    let totalDuplicatedSize = 0;
    let totalDuplicatedInstructions = 0;

    for (const func of functions) {
      if (seen.has(func.index)) continue;

      const duplicates = this.findDuplicates(func, functions.filter(f => !seen.has(f.index)));
      if (duplicates.length > 1) {
        const group = {
          functions: duplicates.map(f => f.index).sort((a, b) => a - b),
          bodySize: duplicates.reduce((sum, f) => sum + f.size, 0),
          fingerprint: this.generateFingerprint(duplicates[0]),
          instructionCount: duplicates.reduce((sum, f) => sum + this.countInstructions(f.body), 0),
          similarity: this.determineSimilarity(duplicates)
        };
        groups.push(group);
        duplicates.forEach(f => seen.add(f.index));
        duplicatedCount += duplicates.length;
        totalDuplicatedSize += group.bodySize;
        totalDuplicatedInstructions += group.instructionCount;
        largestGroup = Math.max(largestGroup, duplicates.length);
      } else {
        uniqueCount++;
        seen.add(func.index);
      }
    }

    const totalSize = functions.reduce((sum, f) => sum + f.size, 0);
    const duplicateCodePercentage = totalSize > 0 ? (totalDuplicatedSize / totalSize) * 100 : 0;

    return {
      groups,
      stats: {
        uniqueFunctions: uniqueCount,
        duplicateGroups: groups.length,
        duplicatedFunctions: duplicatedCount,
        largestGroupSize: largestGroup,
        duplicateCodePercentage: parseFloat(duplicateCodePercentage.toFixed(2)),
        duplicatedInstructionCount: totalDuplicatedInstructions
      }
    };
  }

  findDuplicates(reference, candidates) {
    const duplicates = [reference];

    for (const candidate of candidates) {
      if (candidate.index === reference.index) continue;

      if (this.isExactDuplicate(reference, candidate)) {
        duplicates.push(candidate);
      } else if (this.options.includeNormalized && this.isNormalizedDuplicate(reference, candidate)) {
        duplicates.push(candidate);
      } else if (this.isSimilar(reference, candidate)) {
        duplicates.push(candidate);
      }
    }

    return duplicates;
  }

  isExactDuplicate(a, b) {
    return a.size === b.size && this.compareBuffers(a.body, b.body);
  }

  isNormalizedDuplicate(a, b) {
    const normA = this.normalizeInstructions(a.body);
    const normB = this.normalizeInstructions(b.body);
    return this.compareBuffers(normA, normB);
  }

  isSimilar(a, b) {
    const normA = this.normalizeInstructions(a.body);
    const normB = this.normalizeInstructions(b.body);
    const similarity = this.calculateSimilarity(normA, normB);
    return similarity >= this.options.similarityThreshold;
  }

  normalizeInstructions(buffer) {
    const instructions = this.decodeInstructions(buffer);
    const normalized = instructions.map(instr => {
      if (instr.type === 'local' || instr.type === 'global') {
        return `${instr.opcode} ${instr.type}`;
      }
      return instr.opcode;
    });
    return new TextEncoder().encode(normalized.join(' '));
  }

  decodeInstructions(buffer) {
    const instructions = [];
    let pos = 0;

    while (pos < buffer.length) {
      const opcode = buffer[pos++];
      let type = null;

      switch (opcode) {
        case 0x20: // local.get
        case 0x21: // local.set
        case 0x22: // local.tee
        case 0x23: // global.get
        case 0x24: // global.set
          type = buffer[pos++] === 0x7F ? 'i32' : 'i64';
          instructions.push({ opcode: `local.${type}`, type: 'local' });
          break;
        default:
          instructions.push({ opcode: `0x${opcode.toString(16).padStart(2, '0')}` });
      }
    }

    return instructions;
  }

  countInstructions(buffer) {
    let count = 0;
    let pos = 0;

    while (pos < buffer.length) {
      const opcode = buffer[pos++];
      if (opcode >= 0x00 && opcode <= 0xFF) {
        count++;
        if (opcode === 0x20 || opcode === 0x21 || opcode === 0x22 || 
            opcode === 0x23 || opcode === 0x24) {
          pos++;
        }
      }
    }

    return count;
  }

  calculateSimilarity(a, b) {
    const lenA = a.length;
    const lenB = b.length;
    const maxLen = Math.max(lenA, lenB);
    if (maxLen === 0) return 100;

    let matches = 0;
    const minLen = Math.min(lenA, lenB);

    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) matches++;
    }

    return (matches / maxLen) * 100;
  }

  generateFingerprint(func) {
    const hash = this.simpleHash(func.body);
    return hash.substring(0, 16);
  }

  simpleHash(buffer) {
    let hash = 0;
    for (let i = 0; i < buffer.length; i++) {
      hash = (hash << 5) - hash + buffer[i];
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  compareBuffers(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

async function analyzeWasm(wasmBuffer, options = {}) {
  const analyzer = new WasmAnalyzer(options);
  return analyzer.analyze(wasmBuffer);
}

module.exports = { WasmAnalyzer, analyzeWasm };
