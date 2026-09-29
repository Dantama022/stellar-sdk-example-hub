const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { analyzeWasm, compareWasmArtifacts, recordsToCsv } = require('../examples/soroban/wasm-strings/analyzer');

function createMockWasm(customName, customPayload, dataPayload) {
  const magic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  const version = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  
  let sections = [];
  
  if (customName && customPayload) {
    const nameBuf = Buffer.from(customName, 'utf8');
    const payloadLen = 1 + nameBuf.length + customPayload.length;
    const sizeBytes = Buffer.from([payloadLen]);
    const sec = Buffer.concat([
      Buffer.from([0x00]),
      sizeBytes,
      Buffer.from([nameBuf.length]),
      nameBuf,
      customPayload
    ]);
    sections.push(sec);
  }

  if (dataPayload) {
    const sizeBytes = Buffer.from([dataPayload.length + 2]);
    const sec = Buffer.concat([
      Buffer.from([0x0b]),
      sizeBytes,
      Buffer.from([0x01, 0x00]),
      dataPayload
    ]);
    sections.push(sec);
  }

  return Buffer.concat([magic, version, ...sections]);
}

describe('WASM Embedded String Analyzer', () => {
  const tempWasm1 = path.join(__dirname, 'test1.wasm');
  const tempWasm2 = path.join(__dirname, 'test2.wasm');

  before(() => {
    const wasm1 = createMockWasm('meta', Buffer.from('Error: Unauthorized access'), Buffer.from('https://stellar.org'));
    fs.writeFileSync(tempWasm1, wasm1);

    const wasm2 = createMockWasm('meta', Buffer.from('Error: Authorized access'), Buffer.from('https://stellar.org/updated'));
    fs.writeFileSync(tempWasm2, wasm2);
  });

  after(() => {
    if (fs.existsSync(tempWasm1)) fs.unlinkSync(tempWasm1);
    if (fs.existsSync(tempWasm2)) fs.unlinkSync(tempWasm2);
  });

  it('should analyze WASM and extract strings without errors', () => {
    const report = analyzeWasm(tempWasm1, { minLength: 4 });
    assert.ok(report.metadata.totalDetectedStrings > 0);
    assert.ok(report.metadata.uniqueStrings > 0);
    assert.ok(report.metadata.printableDataPercentage > 0);
    assert.strictEqual(report.strings.some(s => s.value.includes('Unauthorized')), true);
  });

  it('should classify categories correctly', () => {
    const report = analyzeWasm(tempWasm1, { minLength: 4 });
    const errStr = report.strings.find(s => s.category === 'Error/Message');
    assert.ok(errStr);
    const urlStr = report.strings.find(s => s.category === 'URL-like');
    assert.ok(urlStr);
  });

  it('should support comparison mode', () => {
    const comparison = compareWasmArtifacts(tempWasm1, tempWasm2);
    assert.ok(comparison.addedStrings.length > 0);
    assert.ok(comparison.removedStrings.length > 0);
    assert.strictEqual(comparison.countDiff.artifact1Total, comparison.countDiff.artifact2Total);
  });

  it('should generate CSV output correctly', () => {
    const report = analyzeWasm(tempWasm1, { minLength: 4 });
    const csv = recordsToCsv(report.strings);
    assert.ok(csv.includes('Value,ByteLength,Encoding'));
    assert.ok(csv.includes('Unauthorized'));
  });
});
