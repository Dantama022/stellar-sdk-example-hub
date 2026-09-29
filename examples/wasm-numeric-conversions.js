/**
 * WASM Numeric Conversion Analysis Example for Soroban Contracts
 * 
 * Parses compiled WASM binaries statically to identify, classify, and evaluate
 * numeric conversion instructions, detecting potential precision loss, narrowing,
 * reinterpretation, and redundant conversion chains.
 */

const fs = require('fs');

const CONVERSION_OPCODES = new Map([
  [0xa7, { name: 'i32.wrap_i64', src: 'i64', dest: 'i32', category: 'Integer truncation', narrowing: true, highOrderBitsRisk: true }],
  [0xa8, { name: 'i32.trunc_f32_s', src: 'f32', dest: 'i32', category: 'Floating-point-to-integer', trapping: true }],
  [0xa9, { name: 'i32.trunc_f32_u', src: 'f32', dest: 'i32', category: 'Floating-point-to-integer', trapping: true }],
  [0xaa, { name: 'i32.trunc_f64_s', src: 'f64', dest: 'i32', category: 'Floating-point-to-integer', trapping: true }],
  [0xab, { name: 'i32.trunc_f64_u', src: 'f64', dest: 'i32', category: 'Floating-point-to-integer', trapping: true }],
  [0xac, { name: 'i64.extend_i32_s', src: 'i32', dest: 'i64', category: 'Integer extension', widening: true, signExtension: true }],
  [0xad, { name: 'i64.extend_i32_u', src: 'i32', dest: 'i64', category: 'Integer extension', widening: true, signExtension: false, reinterpretation: true }],
  [0xae, { name: 'i32.trunc_sat_f32_s', src: 'f32', dest: 'i32', category: 'Floating-point-to-integer', saturating: true }],
  [0xaf, { name: 'i32.trunc_sat_f32_u', src: 'f32', dest: 'i32', category: 'Floating-point-to-integer', saturating: true }],
  [0xb0, { name: 'i32.trunc_sat_f64_s', src: 'f64', dest: 'i32', category: 'Floating-point-to-integer', saturating: true }],
  [0xb1, { name: 'i32.trunc_sat_f64_u', src: 'f64', dest: 'i32', category: 'Floating-point-to-integer', saturating: true }],
  [0xb2, { name: 'f32.convert_i32_s', src: 'i32', dest: 'f32', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xb3, { name: 'f32.convert_i32_u', src: 'i32', dest: 'f32', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xb4, { name: 'f32.convert_i64_s', src: 'i64', dest: 'f32', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xb5, { name: 'f32.convert_i64_u', src: 'i64', dest: 'f32', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xb6, { name: 'f32.demote_f64', src: 'f64', dest: 'f32', category: 'Floating-point narrowing', narrowing: true, precisionRisk: true }],
  [0xb7, { name: 'f64.convert_i32_s', src: 'i32', dest: 'f64', category: 'Integer-to-floating-point' }],
  [0xb8, { name: 'f64.convert_i32_u', src: 'i32', dest: 'f64', category: 'Integer-to-floating-point' }],
  [0xb9, { name: 'f64.convert_i64_s', src: 'i64', dest: 'f64', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xba, { name: 'f64.convert_i64_u', src: 'i64', dest: 'f64', category: 'Integer-to-floating-point', precisionRisk: true }],
  [0xbb, { name: 'f64.promote_f32', src: 'f32', dest: 'f64', category: 'Floating-point widening', widening: true }],
  [0xbc, { name: 'i32.reinterpret_f32', src: 'f32', dest: 'i32', category: 'Reinterpretation', reinterpretation: true }],
  [0xbd, { name: 'i64.reinterpret_f64', src: 'f64', dest: 'i64', category: 'Reinterpretation', reinterpretation: true }],
  [0xbe, { name: 'f32.reinterpret_i32', src: 'i32', dest: 'f32', category: 'Reinterpretation', reinterpretation: true }],
  [0xbf, { name: 'f64.reinterpret_i64', src: 'i64', dest: 'f64', category: 'Reinterpretation', reinterpretation: true }]
]);

function readVarUint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, bytesRead };
    }
    shift += 7;
  }
  throw new Error('Unexpected end of WASM buffer while reading varuint');
}

function parseWasmConversions(wasmBuffer) {
  if (wasmBuffer.length < 8 || wasmBuffer.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('Invalid WASM magic header');
  }

  const conversions = [];
  const functionConversions = new Map();
  let offset = 8;
  let currentFuncIndex = 0;
  let codeSectionCount = 0;

  while (offset < wasmBuffer.length) {
    const sectionId = wasmBuffer[offset++];
    const { value: sectionSize, bytesRead: sizeLen } = readVarUint(wasmBuffer, offset);
    offset += sizeLen;
    const sectionEnd = offset + sectionSize;

    if (sectionId === 10) { // Code section
      const { value: count, bytesRead: countLen } = readVarUint(wasmBuffer, offset);
      offset += countLen;
      codeSectionCount = count;

      for (let i = 0; i < count; i++) {
        const funcIndex = i;
        const { value: bodySize, bytesRead: bodySizeLen } = readVarUint(wasmBuffer, offset);
        offset += bodySizeLen;
        const bodyEnd = offset + bodySize;

        const { value: localDeclCount, bytesRead: localCountLen } = readVarUint(wasmBuffer, offset);
        offset += localCountLen;
        for (let l = 0; l < localDeclCount; l++) {
          const { bytesRead: countLen } = readVarUint(wasmBuffer, offset);
          offset += countLen;
          offset += 1; // type
        }

        let instructionIndex = 0;
        let currentBlock = 0;

        while (offset < bodyEnd) {
          const opcode = wasmBuffer[offset++];
          instructionIndex++;

          if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
            currentBlock++;
          } else if (opcode === 0x0b) {
            if (currentBlock > 0) currentBlock--;
          }

          if (CONVERSION_OPCODES.has(opcode)) {
            const meta = CONVERSION_OPCODES.get(opcode);
            const record = {
              functionIndex: funcIndex,
              basicBlock: currentBlock,
              instructionIndex,
              opcode: `0x${opcode.toString(16).padStart(2, '0')}`,
              mnemonic: meta.name,
              sourceType: meta.src,
              destinationType: meta.dest,
              category: meta.category,
              narrowing: !!meta.narrowing,
              widening: !!meta.widening,
              reinterpretation: !!meta.reinterpretation,
              precisionRisk: !!meta.precisionRisk,
              trapping: !!meta.trapping,
              saturating: !!meta.saturating
            };

            conversions.push(record);
            if (!functionConversions.has(funcIndex)) {
              functionConversions.set(funcIndex, []);
            }
            functionConversions.get(funcIndex).push(record);
          }
        }
        offset = bodyEnd;
      }
    } else {
      offset = sectionEnd;
    }
  }

  return { conversions, functionConversions, codeSectionCount };
}

function analyzeChains(conversions) {
  const chains = [];
  for (let i = 0; i < conversions.length - 1; i++) {
    const curr = conversions[i];
    const next = conversions[i + 1];
    if (curr.functionIndex === next.functionIndex) {
      if (curr.destinationType === next.sourceType) {
        let patternType = 'general-chain';
        if (curr.widening && next.narrowing) patternType = 'Widen -> narrow';
        else if (curr.narrowing && next.widening) patternType = 'Narrow -> widen';
        else if (curr.reinterpretation && next.reinterpretation) patternType = 'Repeated reinterpretation';
        else if (curr.sourceType === next.destinationType && curr.category.includes('Integer') && next.category.includes('Floating')) {
          patternType = 'Integer -> float -> integer';
        }

        chains.push({
          functionIndex: curr.functionIndex,
          pattern: patternType,
          first: curr.mnemonic,
          second: next.mnemonic,
          suspicious: patternType !== 'general-chain'
        });
      }
    }
  }
  return chains;
}

function analyzeWasmNumericConversions(wasmFilePath) {
  const buffer = fs.readFileSync(wasmFilePath);
  const { conversions, functionConversions, codeSectionCount } = parseWasmConversions(buffer);
  const chains = analyzeChains(conversions);

  const categories = {};
  let narrowingCount = 0;
  let wideningCount = 0;
  let precisionLossCount = 0;

  for (const c of conversions) {
    categories[c.category] = (categories[c.category] || 0) + 1;
    if (c.narrowing) narrowingCount++;
    if (c.widening) wideningCount++;
    if (c.precisionRisk) precisionLossCount++;
  }

  const densityMap = [];
  for (const [funcIndex, convs] of functionConversions.entries()) {
    densityMap.push({ functionIndex, count: convs.length });
  }
  densityMap.sort((a, b) => b.count - a.count);

  const diagnostics = [];
  if (narrowingCount > 0) diagnostics.push({ category: 'lossy', message: `Found ${narrowingCount} narrowing conversion(s) risking high-order bit truncation.` });
  if (precisionLossCount > 0) diagnostics.push({ category: 'lossy', message: `Found ${precisionLossCount} conversion(s) with potential floating-point precision loss.` });
  const suspiciousChains = chains.filter(ch => ch.suspicious);
  if (suspiciousChains.length > 0) {
    diagnostics.push({ category: 'representation-change', message: `Detected ${suspiciousChains.length} redundant or suspicious conversion chain pattern(s).` });
  }
  if (wideningCount > 0) diagnostics.push({ category: 'widening', message: `Observed ${wideningCount} widening conversion(s).` });

  return {
    totalConversions: conversions.length,
    totalFunctions: codeSectionCount,
    categories,
    narrowingConversions: narrowingCount,
    wideningConversions: wideningCount,
    potentialPrecisionLossConversions: precisionLossCount,
    conversionChains: chains,
    suspiciousChainsCount: suspiciousChains.length,
    highestConversionDensityFunctions: densityMap.slice(0, 5),
    diagnostics,
    conversions
  };
}

function main() {
  const args = process.argv.slice(2);
  const wasmFile = args[0];

  if (!wasmFile) {
    console.error('Usage: node wasm-numeric-conversions.js <wasmFile>');
    process.exit(1);
  }

  try {
    console.log(`Analyzing numeric conversions for WASM file: ${wasmFile}\n`);
    const report = analyzeWasmNumericConversions(wasmFile);

    console.log('--- SUMMARY ---');
    console.log(`Total Numeric Conversions: ${report.totalConversions}`);
    console.log(`Narrowing Conversions: ${report.narrowingConversions}`);
    console.log(`Widening Conversions: ${report.wideningConversions}`);
    console.log(`Potential Precision Loss: ${report.potentialPrecisionLossConversions}`);
    console.log(`Conversion Chains: ${report.conversionChains.length} (${report.suspiciousChainsCount} suspicious)`);

    console.log('\n--- CATEGORIES ---');
    for (const [cat, count] of Object.entries(report.categories)) {
      console.log(`  ${cat}: ${count}`);
    }

    console.log('\n--- HIGHEST CONVERSION DENSITY FUNCTIONS ---');
    for (const fn of report.highestConversionDensityFunctions) {
      console.log(`  Function [${fn.functionIndex}]: ${fn.count} conversions`);
    }

    console.log('\n--- DIAGNOSTICS ---');
    for (const diag of report.diagnostics) {
      console.log(`  [${diag.category.toUpperCase()}] ${diag.message}`);
    }
  } catch (err) {
    console.error(`Error analyzing WASM file: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseWasmConversions,
  analyzeWasmNumericConversions,
  CONVERSION_OPCODES
};