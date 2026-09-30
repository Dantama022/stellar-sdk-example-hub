const WASM_FEATURES = {
  BULK_MEMORY: 'bulk-memory',
  REFERENCE_TYPES: 'reference-types',
  TABLE_INSTRUCTIONS: 'table-instructions',
  MULTIPLE_TABLES: 'multiple-tables',
  MEMORY_ADVANCED: 'memory-advanced',
  MULTIPLE_MEMORIES: 'multiple-memories',
  SIMD: 'simd',
  EXCEPTIONS: 'exceptions',
  TYPED_FUNCTION_REF: 'typed-function-ref',
  INDIRECT_CALLS: 'indirect-calls',
  MEMORY_INIT: 'memory-init',
  DATA_SEGMENT_OPS: 'data-segment-ops',
  ELEMENT_SEGMENT_OPS: 'element-segment-ops',
  SHARED_MEMORY: 'shared-memory',
  ATOMICS: 'atomics'
};

const OPCODE_FEATURE_MAP = {
  0xFC00: WASM_FEATURES.MEMORY_INIT,
  0xFC01: WASM_FEATURES.DATA_SEGMENT_OPS,
  0xFC02: WASM_FEATURES.ELEMENT_SEGMENT_OPS,
  0xFC03: WASM_FEATURES.TABLE_INSTRUCTIONS,
  0xFE00: WASM_FEATURES.BULK_MEMORY,
  0xFE01: WASM_FEATURES.BULK_MEMORY,
  0xFE02: WASM_FEATURES.BULK_MEMORY,
  0xFE03: WASM_FEATURES.BULK_MEMORY,
  0xFE10: WASM_FEATURES.REFERENCE_TYPES,
  0xFE11: WASM_FEATURES.REFERENCE_TYPES,
  0xFE12: WASM_FEATURES.REFERENCE_TYPES,
  0xFD00: WASM_FEATURES.SIMD,
  0xFD01: WASM_FEATURES.SIMD,
  0xFD02: WASM_FEATURES.SIMD,
  0xFD03: WASM_FEATURES.SIMD,
  0x06: WASM_FEATURES.ATOMICS,
  0x07: WASM_FEATURES.ATOMICS,
  0xFE20: WASM_FEATURES.EXCEPTIONS,
  0xFE21: WASM_FEATURES.EXCEPTIONS,
  0xFE22: WASM_FEATURES.EXCEPTIONS
};

const SECTION_FEATURE_MAP = {
  0: [WASM_FEATURES.TYPED_FUNCTION_REF],
  1: [WASM_FEATURES.MULTIPLE_TABLES, WASM_FEATURES.TABLE_INSTRUCTIONS],
  2: [WASM_FEATURES.MULTIPLE_MEMORIES, WASM_FEATURES.MEMORY_ADVANCED],
  5: [WASM_FEATURES.MULTIPLE_TABLES],
  6: [WASM_FEATURES.MULTIPLE_MEMORIES],
  8: [WASM_FEATURES.EXCEPTIONS],
  9: [WASM_FEATURES.ELEMENT_SEGMENT_OPS],
  10: [WASM_FEATURES.DATA_SEGMENT_OPS],
  12: [WASM_FEATURES.SHARED_MEMORY]
};

function parseWasmModule(buffer) {
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const magic = String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
  if (magic !== '\0asm') {
    throw new Error('Invalid WASM magic number');
  }
  offset += 4;

  const version = view.getUint32(offset, true);
  offset += 4;

  const sections = [];
  while (offset < buffer.length) {
    const sectionId = view.getUint8(offset);
    offset += 1;

    const sectionSize = view.getUint32(offset, true);
    offset += 4;

    const sectionStart = offset;
    const sectionData = buffer.slice(sectionStart, sectionStart + sectionSize);
    sections.push({ id: sectionId, size: sectionSize, data: sectionData });

    offset += sectionSize;
  }

  return {
    magic,
    version,
    sections,
    raw: buffer
  };
}

function detectFeaturesFromSections(module) {
  const features = new Set();
  const sectionLocations = {};

  for (const section of module.sections) {
    const sectionFeatures = SECTION_FEATURE_MAP[section.id] || [];
    for (const feature of sectionFeatures) {
      features.add(feature);
      if (!sectionLocations[feature]) {
        sectionLocations[feature] = [];
      }
      sectionLocations[feature].push(`section ${section.id}`);
    }

    if (section.id === 1 && section.data.length > 0) {
      const typeCount = new DataView(section.data.buffer).getUint32(0, true);
      if (typeCount > 1) {
        features.add(WASM_FEATURES.MULTIPLE_TABLES);
        if (!sectionLocations[WASM_FEATURES.MULTIPLE_TABLES]) {
          sectionLocations[WASM_FEATURES.MULTIPLE_TABLES] = [];
        }
        sectionLocations[WASM_FEATURES.MULTIPLE_TABLES].push(`section ${section.id}`);
      }
    }

    if (section.id === 2 && section.data.length > 0) {
      const memCount = new DataView(section.data.buffer).getUint32(0, true);
      if (memCount > 1) {
        features.add(WASM_FEATURES.MULTIPLE_MEMORIES);
        if (!sectionLocations[WASM_FEATURES.MULTIPLE_MEMORIES]) {
          sectionLocations[WASM_FEATURES.MULTIPLE_MEMORIES] = [];
        }
        sectionLocations[WASM_FEATURES.MULTIPLE_MEMORIES].push(`section ${section.id}`);
      }
    }
  }

  return { features: Array.from(features), locations: sectionLocations };
}

function detectFeaturesFromCode(module) {
  const features = new Set();
  const featureLocations = {};
  const featureFunctions = {};
  const featureCounts = {};

  for (const section of module.sections) {
    if (section.id === 10) {
      const view = new DataView(section.data.buffer);
      let offset = 0;
      const codeCount = view.getUint32(offset, true);
      offset += 4;

      for (let i = 0; i < codeCount; i++) {
        const bodySize = view.getUint32(offset, true);
        offset += 4;
        const bodyStart = offset;
        const bodyEnd = bodyStart + bodySize;

        const funcBody = section.data.slice(bodyStart, bodyEnd);
        const funcView = new DataView(funcBody.buffer);
        let funcOffset = 0;

        const localCount = funcView.getUint32(funcOffset, true);
        funcOffset += 4;

        for (let j = 0; j < localCount; j++) {
          const locals = funcView.getUint32(funcOffset, true);
          funcOffset += 4;
          const type = funcView.getUint8(funcOffset);
          funcOffset += 1;
        }

        const codeStart = funcOffset;
        while (funcOffset < funcBody.length) {
          const opcode = funcView.getUint16(funcOffset, true);
          funcOffset += 1;

          const feature = OPCODE_FEATURE_MAP[opcode];
          if (feature) {
            features.add(feature);
            if (!featureLocations[feature]) {
              featureLocations[feature] = [];
            }
            featureLocations[feature].push(`function ${i} (offset ${funcOffset - 1})`);

            if (!featureFunctions[feature]) {
              featureFunctions[feature] = new Set();
            }
            featureFunctions[feature].add(`function ${i}`);

            if (!featureCounts[feature]) {
              featureCounts[feature] = 0;
            }
            featureCounts[feature]++;
          }

          if (opcode === 0x11) {
            features.add(WASM_FEATURES.INDIRECT_CALLS);
            const typeIndex = funcView.getUint32(funcOffset, true);
            funcOffset += 4;
            const tableIndex = funcView.getUint32(funcOffset, true);
            funcOffset += 4;

            if (!featureLocations[WASM_FEATURES.INDIRECT_CALLS]) {
              featureLocations[WASM_FEATURES.INDIRECT_CALLS] = [];
            }
            featureLocations[WASM_FEATURES.INDIRECT_CALLS].push(`function ${i} (offset ${funcOffset - 5})`);

            if (!featureFunctions[WASM_FEATURES.INDIRECT_CALLS]) {
              featureFunctions[WASM_FEATURES.INDIRECT_CALLS] = new Set();
            }
            featureFunctions[WASM_FEATURES.INDIRECT_CALLS].add(`function ${i}`);

            if (!featureCounts[WASM_FEATURES.INDIRECT_CALLS]) {
              featureCounts[WASM_FEATURES.INDIRECT_CALLS] = 0;
            }
            featureCounts[WASM_FEATURES.INDIRECT_CALLS]++;
          }
        }
      }
    }
  }

  return {
    features: Array.from(features),
    locations: featureLocations,
    functions: Object.fromEntries(
      Object.entries(featureFunctions).map(([k, v]) => [k, Array.from(v)])
    ),
    counts: featureCounts
  };
}

function detectFeatures(module) {
  const sectionFeatures = detectFeaturesFromSections(module);
  const codeFeatures = detectFeaturesFromCode(module);

  const allFeatures = new Set([...sectionFeatures.features, ...codeFeatures.features]);
  const detected = {};

  for (const feature of allFeatures) {
    detected[feature] = {
      count: codeFeatures.counts[feature] || 0,
      functions: codeFeatures.functions[feature] || [],
      locations: [
        ...(sectionFeatures.locations[feature] || []),
        ...(codeFeatures.locations[feature] || [])
      ]
    };
  }

  const allPossibleFeatures = Object.values(WASM_FEATURES);
  const undetected = allPossibleFeatures.filter(f => !allFeatures.has(f));

  return {
    detected,
    undetected,
    unknown: []
  };
}

function compareFeatures(features1, features2) {
  const allFeatures = new Set([
    ...Object.keys(features1.detected),
    ...Object.keys(features2.detected),
    ...features1.undetected,
    ...features2.undetected
  ]);

  const newFeatures = [];
  const removedFeatures = [];
  const changedCounts = {};
  const newFunctionUsage = {};
  const removedFunctionUsage = {};

  for (const feature of allFeatures) {
    const in1 = feature in features1.detected;
    const in2 = feature in features2.detected;

    if (in2 && !in1) {
      newFeatures.push(feature);
    } else if (in1 && !in2) {
      removedFeatures.push(feature);
    }

    if (in1 && in2) {
      const count1 = features1.detected[feature].count;
      const count2 = features2.detected[feature].count;
      if (count1 !== count2) {
        changedCounts[feature] = { old: count1, new: count2 };
      }

      const funcs1 = new Set(features1.detected[feature].functions);
      const funcs2 = new Set(features2.detected[feature].functions);

      const newFuncs = [...funcs2].filter(f => !funcs1.has(f));
      if (newFuncs.length > 0) {
        newFunctionUsage[feature] = newFuncs;
      }

      const removedFuncs = [...funcs1].filter(f => !funcs2.has(f));
      if (removedFuncs.length > 0) {
        removedFunctionUsage[feature] = removedFuncs;
      }
    }
  }

  return {
    newFeatures,
    removedFeatures,
    changedCounts,
    newFunctionUsage,
    removedFunctionUsage
  };
}

module.exports = {
  parseWasmModule,
  detectFeatures,
  compareFeatures,
  WASM_FEATURES
};