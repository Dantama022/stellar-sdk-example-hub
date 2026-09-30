const { program } = require('commander');
const fs = require('fs');
const path = require('path');

// Existing commands are imported here (placeholder)
// const otherCommand = require('./otherCommand');

// Import the new wasm complexity analysis function
const { runWasmComplexity } = require('./wasmComplexity');

program
  .name('stellar-api-inspector')
  .description('CLI utilities for inspecting Stellar Soroban artifacts')
  .version('1.0.0');

// Placeholder for existing commands
// program.command('existing').action(() => { /* ... */ });

/**
 * wasm-complexity <wasmFile>
 *   --json            Output report as JSON
 *   --threshold <n>   Highlight functions with a complexity score >= n (default: 100)
 */
program
  .command('wasm-complexity <wasmFile>')
  .description('Analyze a Soroban contract WASM file and report structural complexity')
  .option('--json', 'output report in JSON format')
  .option('--threshold <number>', 'complexity threshold for highlighting', parseInt, 100)
  .action(async (wasmFile, options) => {
    try {
      const absolutePath = path.resolve(process.cwd(), wasmFile);
      if (!fs.existsSync(absolutePath)) {
        console.error(`Error: File not found – ${absolutePath}`);
        process.exit(1);
      }
      const buffer = fs.readFileSync(absolutePath);
      const report = await runWasmComplexity(buffer, { threshold: options.threshold });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        // Human‑readable console output
        console.log('\
=== Module Summary ===');
        console.log(`Functions analyzed: ${report.functions.length}`);
        console.log(`Total instructions: ${report.totalInstructionCount}`);
        console.log(`Aggregate complexity score: ${report.aggregateComplexityScore}\
`);
        console.table(
          report.functions.map(fn => ({
            name: fn.name,
            instr: fn.instructionCount,
            size: fn.codeSize,
            ctrlFlow: fn.controlFlowCount,
            branch: fn.branchCount,
            call: fn.callCount,
            memory: fn.memoryOpCount,
            locals: fn.localAccessCount,
            complexity: fn.complexityScore,
            highlight: fn.complexityScore >= options.threshold ? 'YES' : ''
          }))
        );
        if (report.highestComplexity.length) {
          console.log('\
Functions with highest complexity:');
          report.highestComplexity.forEach(fn => {
            console.log(`- ${fn.name} (score: ${fn.complexityScore})`);
          });
        }
      }
    } catch (err) {
      console.error('Analysis failed:', err.message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
