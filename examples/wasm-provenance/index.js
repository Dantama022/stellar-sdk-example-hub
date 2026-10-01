import { Command } from 'commander';
import { readFileSync } from 'fs';
import { sha256 } from 'js-sha256';
import { parseWasmModule } from '@stellar/stellar-sdk';

const program = new Command();

program
  .name('wasm-provenance')
  .description('Analyze Soroban contract WASM provenance metadata')
  .argument('<wasmFile>', 'Path to WASM file')
  .argument('[wasmFile2]', 'Optional second WASM file for comparison')
  .option('-j, --json', 'Output in JSON format')
  .action(async (wasmFile, wasmFile2, options) => {
    try {
      const result = await analyzeWasmProvenance(wasmFile, wasmFile2);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHumanReadable(result);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();

async function analyzeWasmProvenance(file1, file2) {
  const wasm1 = readFileSync(file1);
  const module1 = parseWasmModule(wasm1);

  const result1 = {
    file: file1,
    moduleInfo: getModuleInfo(module1),
    producers: extractProducers(module1),
    rawProducers: getRawProducers(module1),
    fingerprint: calculateFingerprint(wasm1, module1)
  };

  if (!file2) {
    return result1;
  }

  const wasm2 = readFileSync(file2);
  const module2 = parseWasmModule(wasm2);

  return {
    file1: result1,
    file2: {
      file: file2,
      moduleInfo: getModuleInfo(module2),
      producers: extractProducers(module2),
      rawProducers: getRawProducers(module2),
      fingerprint: calculateFingerprint(wasm2, module2)
    },
    comparison: compareProducers(result1.producers, extractProducers(module2))
  };
}

function getModuleInfo(module) {
  return {
    version: module.version,
    functionCount: module.functions.length,
    importCount: module.imports.length,
    exportCount: module.exports.length,
    codeSize: module.bytes.length,
    hasCustomSections: module.customSections.length > 0
  };
}

function extractProducers(module) {
  const producers = [];
  const raw = getRawProducers(module);

  for (const producer of raw) {
    const category = detectProducerCategory(producer.name);
    producers.push({
      category,
      name: producer.name,
      version: producer.version || 'unknown',
      fields: producer.fields || {}
    });
  }

  return producers;
}

function getRawProducers(module) {
  const producers = [];

  for (const section of module.customSections) {
    if (section.name === 'producers') {
      const data = new TextDecoder().decode(section.data);
      const lines = data.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const match = line.match(/^([^\s]+)\s+([^\s]+)(?:\s+(.*))?$/);
        if (match) {
          producers.push({
            name: match[1],
            version: match[2],
            fields: match[3] ? parseProducerFields(match[3]) : null
          });
        }
      }
    }
  }

  return producers;
}

function parseProducerFields(fieldsStr) {
  const fields = {};
  const parts = fieldsStr.split(';').filter(p => p.trim());

  for (const part of parts) {
    const [key, value] = part.split('=').map(s => s.trim());
    if (key && value) {
      fields[key] = value;
    }
  }

  return fields;
}

function detectProducerCategory(name) {
  if (name.includes('rustc')) return 'compiler';
  if (name.includes('soroban-cli')) return 'compiler';
  if (name.includes('wasm-opt')) return 'linker';
  if (name.includes('lld')) return 'linker';
  if (name.includes('clang')) return 'compiler';
  if (name.includes('gcc')) return 'compiler';
  if (name.includes('go')) return 'compiler';
  if (name.includes('swift')) return 'compiler';
  return 'other';
}

function calculateFingerprint(wasm, module) {
  const data = JSON.stringify({
    moduleInfo: getModuleInfo(module),
    producers: extractProducers(module)
  });
  return 'sha256-' + sha256(data);
}

function compareProducers(oldProducers, newProducers) {
  const comparison = {
    added: [],
    removed: [],
    changed: [],
    unchanged: []
  };

  const oldMap = new Map(oldProducers.map(p => [p.name, p]));
  const newMap = new Map(newProducers.map(p => [p.name, p]));

  for (const [name, newProd] of newMap) {
    const oldProd = oldMap.get(name);
    if (!oldProd) {
      comparison.added.push(name);
    } else if (JSON.stringify(oldProd) !== JSON.stringify(newProd)) {
      comparison.changed.push({
        name,
        old: oldProd,
        new: newProd
      });
    } else {
      comparison.unchanged.push(name);
    }
  }

  for (const [name] of oldMap) {
    if (!newMap.has(name)) {
      comparison.removed.push(name);
    }
  }

  return comparison;
}

function printHumanReadable(result) {
  if (result.file1 && result.file2) {
    printComparison(result);
    return;
  }

  const data = result.file1 || result;
  console.log(`\nWASM Provenance Analysis: ${data.file}\n`);
  console.log('Module Information:');
  console.log(`  Version: ${data.moduleInfo.version}`);
  console.log(`  Functions: ${data.moduleInfo.functionCount}`);
  console.log(`  Imports: ${data.moduleInfo.importCount}`);
  console.log(`  Exports: ${data.moduleInfo.exportCount}`);
  console.log(`  Code Size: ${data.moduleInfo.codeSize} bytes`);
  console.log(`  Custom Sections: ${data.moduleInfo.hasCustomSections ? 'Yes' : 'No'}`);

  console.log('\nProducers:');
  if (data.producers.length === 0) {
    console.log('  No producer metadata found');
  } else {
    for (const producer of data.producers) {
      console.log(`  ${producer.category.toUpperCase()}: ${producer.name} ${producer.version}`);
      if (Object.keys(producer.fields).length > 0) {
        console.log('    Fields:');
        for (const [key, value] of Object.entries(producer.fields)) {
          console.log(`      ${key}: ${value}`);
        }
      }
    }
  }

  console.log(`\nFingerprint: ${data.fingerprint}`);
}

function printComparison(data) {
  console.log('\nWASM Provenance Comparison\n');

  console.log('File 1:', data.file1.file);
  console.log('File 2:', data.file2.file);

  console.log('\nComparison Results:');
  console.log(`  Added producers: ${data.comparison.added.length}`);
  console.log(`  Removed producers: ${data.comparison.removed.length}`);
  console.log(`  Changed producers: ${data.comparison.changed.length}`);
  console.log(`  Unchanged producers: ${data.comparison.unchanged.length}`);

  if (data.comparison.added.length > 0) {
    console.log('\nAdded producers:');
    for (const name of data.comparison.added) {
      console.log(`  - ${name}`);
    }
  }

  if (data.comparison.removed.length > 0) {
    console.log('\nRemoved producers:');
    for (const name of data.comparison.removed) {
      console.log(`  - ${name}`);
    }
  }

  if (data.comparison.changed.length > 0) {
    console.log('\nChanged producers:');
    for (const change of data.comparison.changed) {
      console.log(`  - ${change.name}:`);
      console.log(`    Old: ${change.old.version}`);
      console.log(`    New: ${change.new.version}`);
    }
  }
}