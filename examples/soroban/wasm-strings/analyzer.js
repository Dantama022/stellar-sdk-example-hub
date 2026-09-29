const fs = require('fs');
const crypto = require('crypto');

function computeHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function isPrintableAscii(code) {
  return code >= 32 && code <= 126;
}

function isValidUtf8(buf) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

function classifyEncoding(buf) {
  let allAscii = true;
  for (let i = 0; i < buf.length; i++) {
    if (!isPrintableAscii(buf[i])) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) return 'ASCII';
  if (isValidUtf8(buf)) return 'UTF-8';
  return 'Binary/Unknown';
}

function categorizeString(str) {
  if (/error|fail|panic|invalid|unauthorized|missing|assert/i.test(str)) return 'Error/Message';
  if (/^https?:\/\/|^www\./i.test(str)) return 'URL-like';
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str) && str.length < 64) return 'Identifier-like';
  if (/^[\/\\].*[\/\\].*$/.test(str) || /^[a-zA-Z]:\\/.test(str)) return 'Path-like';
  if (/^-?\d+(\.\d+)?$/.test(str)) return 'Numeric';
  return 'General';
}

function parseWasmSections(wasmBuffer) {
  let offset = 0;
  if (wasmBuffer.length < 8) throw new Error('Invalid WASM: file too short');
  
  const magic = wasmBuffer.readUInt32LE(0);
  const version = wasmBuffer.readUInt32LE(4);
  if (magic !== 0x6d736100) throw new Error('Invalid WASM magic number');
  
  offset = 8;
  const sections = [];
  let dataSegmentCount = 0;

  while (offset < wasmBuffer.length) {
    const sectionOffset = offset;
    const sectionId = wasmBuffer[offset];
    offset += 1;
    
    let sectionSize = 0;
    let shift = 0;
    let byte;
    do {
      if (offset >= wasmBuffer.length) break;
      byte = wasmBuffer[offset];
      offset += 1;
      sectionSize |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x7f);

    const sectionEnd = offset + sectionSize;
    const payload = wasmBuffer.slice(offset, Math.min(sectionEnd, wasmBuffer.length));

    if (sectionId === 0) {
      // Custom section
      let nameLenIdx = 0;
      if (nameLenIdx < payload.length) {
        const nameLen = payload[nameLenIdx];
        const name = payload.slice(nameLenIdx + 1, nameLenIdx + 1 + nameLen).toString('utf8');
        sections.push({
          id: 0,
          name: `custom(${name})`,
          offset: sectionOffset,
          payload: payload.slice(nameLenIdx + 1 + nameLen)
        });
      }
    } else if (sectionId === 11) {
      // Data section
      sections.push({
        id: 11,
        name: `data(segment_${dataSegmentCount++})`,
        offset: sectionOffset,
        payload: payload
      });
    } else {
      sections.push({
        id: sectionId,
        name: `section_${sectionId}`,
        offset: sectionOffset,
        payload: payload
      });
    }

    offset = sectionEnd;
  }

  return sections;
}

function extractStringsFromBuffer(buffer, sectionName, baseOffset, minLength = 4, maxLength = Infinity) {
  const results = [];
  let currentBuffer = [];
  let startByteOffset = -1;

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    const isPrintable = (byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13;

    if (isPrintable) {
      if (currentBuffer.length === 0) {
        startByteOffset = baseOffset + i;
      }
      currentBuffer.push(byte);
    } else {
      if (currentBuffer.length >= minLength) {
        const subBuf = Buffer.from(currentBuffer);
        if (subBuf.length <= maxLength) {
          const strVal = subBuf.toString('utf8');
          const encoding = classifyEncoding(subBuf);
          const category = categorizeString(strVal);
          let termination = 'length-delimited';
          if (i < buffer.length && buffer[i] === 0) {
            termination = 'null-terminated';
          }

          results.push({
            value: strVal,
            byteLength: subBuf.length,
            encoding,
            section: sectionName,
            segmentIndex: sectionName.includes('segment_') ? sectionName : null,
            byteOffset: startByteOffset,
            termination,
            category,
            hash: computeHash(strVal)
          });
        }
      }
      currentBuffer = [];
      startByteOffset = -1;
    }
  }

  if (currentBuffer.length >= minLength) {
    const subBuf = Buffer.from(currentBuffer);
    if (subBuf.length <= maxLength) {
      const strVal = subBuf.toString('utf8');
      const encoding = classifyEncoding(subBuf);
      const category = categorizeString(strVal);
      results.push({
        value: strVal,
        byteLength: subBuf.length,
        encoding,
        section: sectionName,
        segmentIndex: sectionName.includes('segment_') ? sectionName : null,
        byteOffset: startByteOffset,
        termination: 'length-delimited',
        category,
        hash: computeHash(strVal)
      });
    }
  }

  return results;
}

function analyzeWasm(wasmPath, options = {}) {
  const buffer = fs.readFileSync(wasmPath);
  const sections = parseWasmSections(buffer);

  const minLength = options.minLength || 4;
  const maxLength = options.maxLength || Infinity;
  let allStrings = [];

  for (const sec of sections) {
    if (options.sectionType && !sec.name.includes(options.sectionType)) {
      continue;
    }
    const extracted = extractStringsFromBuffer(sec.payload, sec.name, sec.offset, minLength, maxLength);
    allStrings.push(...extracted);
  }

  // Filter by options
  let filtered = allStrings.filter(s => {
    if (options.encoding && s.encoding.toLowerCase() !== options.encoding.toLowerCase()) return false;
    if (options.search) {
      const matchCase = options.caseSensitive ? s.value.includes(options.search) : s.value.toLowerCase().includes(options.search.toLowerCase());
      if (!matchCase) return false;
    }
    return true;
  });

  // Frequency analysis
  const frequencyMap = {};
  for (const s of filtered) {
    frequencyMap[s.value] = (frequencyMap[s.value] || 0) + 1;
  }

  const stringRecords = filtered.map(s => ({
    ...s,
    occurrences: frequencyMap[s.value]
  }));

  const uniqueMap = new Map();
  for (const s of stringRecords) {
    if (!uniqueMap.has(s.value)) {
      uniqueMap.set(s.value, s);
    }
  }
  const uniqueStrings = Array.from(uniqueMap.values());

  const topFrequencies = Object.entries(frequencyMap)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  const totalDetected = stringRecords.length;
  const totalUnique = uniqueStrings.length;
  const totalBytes = stringRecords.reduce((acc, curr) => acc + curr.byteLength, 0);
  const avgLength = totalDetected > 0 ? totalBytes / totalDetected : 0;
  const maxLengthDetected = totalDetected > 0 ? Math.max(...stringRecords.map(s => s.byteLength)) : 0;
  const printablePercentage = buffer.length > 0 ? (totalBytes / buffer.length) * 100 : 0;

  const groups = {
    bySection: {},
    byEncoding: {},
    byLengthRange: {},
    byCategory: {}
  };

  for (const s of stringRecords) {
    // Section grouping
    groups.bySection[s.section] = groups.bySection[s.section] || [];
    groups.bySection[s.section].push(s);

    // Encoding grouping
    groups.byEncoding[s.encoding] = groups.byEncoding[s.encoding] || [];
    groups.byEncoding[s.encoding].push(s);

    // Length range grouping
    const rangeKey = s.byteLength <= 10 ? '4-10' : s.byteLength <= 30 ? '11-30' : '31+';
    groups.byLengthRange[rangeKey] = groups.byLengthRange[rangeKey] || [];
    groups.byLengthRange[rangeKey].push(s);

    // Category grouping
    groups.byCategory[s.category] = groups.byCategory[s.category] || [];
    groups.byCategory[s.category].push(s);
  }

  return {
    metadata: {
      file: wasmPath,
      fileSize: buffer.length,
      totalDetectedStrings: totalDetected,
      uniqueStrings: totalUnique,
      totalStringBytes: totalBytes,
      averageStringLength: parseFloat(avgLength.toFixed(2)),
      maximumStringLength: maxLengthDetected,
      printableDataPercentage: parseFloat(printablePercentage.toFixed(2))
    },
    topFrequentStrings: topFrequencies.slice(0, 10),
    groups,
    strings: stringRecords
  };
}

function compareWasmArtifacts(wasmPath1, wasmPath2, options = {}) {
  const report1 = analyzeWasm(wasmPath1, options);
  const report2 = analyzeWasm(wasmPath2, options);

  const set1 = new Set(report1.strings.map(s => s.value));
  const set2 = new Set(report2.strings.map(s => s.value));

  const added = report2.strings.filter(s => !set1.has(s.value));
  const removed = report1.strings.filter(s => !set2.has(s.value));

  const moved = [];
  for (const s1 of report1.strings) {
    const match = report2.strings.find(s2 => s2.value === s1.value && s2.section !== s1.section);
    if (match) {
      moved.push({ value: s1.value, fromSection: s1.section, toSection: match.section });
    }
  }

  return {
    artifact1: wasmPath1,
    artifact2: wasmPath2,
    addedStrings: added,
    removedStrings: removed,
    movedStrings: moved,
    countDiff: {
      artifact1Total: report1.metadata.totalDetectedStrings,
      artifact2Total: report2.metadata.totalDetectedStrings,
      difference: report2.metadata.totalDetectedStrings - report1.metadata.totalDetectedStrings
    }
  };
}

function recordsToCsv(records) {
  const headers = ['Value', 'ByteLength', 'Encoding', 'Section', 'ByteOffset', 'Termination', 'Category', 'Occurrences', 'Hash'];
  const rows = records.map(r => [
    `"${r.value.replace(/"/g, '""')}"`,
    r.byteLength,
    r.encoding,
    r.section,
    r.byteOffset,
    r.termination,
    r.category,
    r.occurrences,
    r.hash
  ].join(','));
  return [headers.join(','), ...rows].join('\n');
}

module.exports = {
  analyzeWasm,
  compareWasmArtifacts,
  recordsToCsv
};
