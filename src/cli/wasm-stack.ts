import { Command } from 'commander';
import { readFileSync } from 'fs';
import { parse } from 'wasm-parser';
import { StackUsageAnalyzer, StackMetrics } from '../analyzer/stack-usage-analyzer';

export function setupWasmStackCommand() {
  const program = new Command('wasm-stack')
    .description('Analyze WASM function stack usage')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|text)', 'text')
    .option('-c, --compare <wasmFile>', 'Compare stack usage with another WASM file')
    .action(async (wasmFile: string, options: any) => {
      try {
        const wasmBuffer = readFileSync(wasmFile);
        
        // Validate WASM
        let wasmModule;
        try {
          wasmModule = parse(wasmBuffer);
        } catch (error) {
          console.error('Invalid WASM file:', error instanceof Error ? error.message : 'Unknown error');
          process.exit(1);
        }

        const analyzer = new StackUsageAnalyzer(wasmModule);

        if (options.compare) {
          // Comparison mode
          const compareBuffer = readFileSync(options.compare);
          let compareModule;
          try {
            compareModule = parse(compareBuffer);
          } catch (error) {
            console.error('Invalid comparison WASM file:', error instanceof Error ? error.message : 'Unknown error');
            process.exit(1);
          }

          const comparison = analyzer.compareStackUsage(compareModule);
          
          if (options.output === 'json') {
            console.log(JSON.stringify(comparison, null, 2));
          } else {
            console.log(formatComparisonOutput(comparison));
          }
        } else {
          // Standard stack analysis
          const metrics = analyzer.getMetrics();
          const statistics = analyzer.getStatistics();
          
          if (options.output === 'json') {
            console.log(JSON.stringify({ metrics, statistics }, null, 2));
          } else {
            console.log(formatTextOutput(metrics, statistics));
          }
        }

      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`File not found: ${wasmFile}`);
        } else {
          console.error('Analysis failed:', error instanceof Error ? error.message : 'Unknown error');
        }
        process.exit(1);
      }
    });

  return program;
}

function formatTextOutput(metrics: StackMetrics[], statistics: any): string {
  const lines: string[] = [];
  
  lines.push('=== WASM Stack Usage Analysis ===\n');
  
  // Statistics
  lines.push('Statistics:');
  lines.push(`  Total Functions: ${statistics.totalFunctions}`);
  lines.push(`  Average Max Stack Depth: ${statistics.averageMaxStackDepth}`);
  
  if (statistics.highestStackUsage) {
    lines.push(`  Highest Stack Usage:`);
    lines.push(`    Function: [${statistics.highestStackUsage.functionIndex}] ${statistics.highestStackUsage.functionName}`);
    lines.push(`    Max Depth: ${statistics.highestStackUsage.maxDepth}`);
  }
  
  lines.push(`  Analysis Status Counts:`);
  lines.push(`    Exact: ${statistics.analysisStatusCounts.exact}`);
  lines.push(`    Estimated: ${statistics.analysisStatusCounts.estimated}`);
  lines.push(`    Partial: ${statistics.analysisStatusCounts.partial}`);
  lines.push(`    Failed: ${statistics.analysisStatusCounts.failed}`);
  lines.push('');
  
  // Per-function metrics
  lines.push('Per-Function Stack Metrics:');
  metrics.forEach(metric => {
    lines.push(`  Function [${metric.functionIndex}] ${metric.functionName}:`);
    lines.push(`    Min Stack Depth: ${metric.minStackDepth}`);
    lines.push(`    Max Stack Depth: ${metric.maxStackDepth}`);
    lines.push(`    Final Stack Depth: ${metric.finalStackDepth}`);
    lines.push(`    Stack Effect Operations: ${metric.stackEffectOperations}`);
    lines.push(`    Analysis Status: ${metric.analysisStatus}`);
    
    if (metric.unsupportedInstructions.length > 0) {
      const instrList = metric.unsupportedInstructions.slice(0, 5).join(', ');
      const more = metric.unsupportedInstructions.length > 5 
        ? ` (and ${metric.unsupportedInstructions.length - 5} more)` 
        : '';
      lines.push(`    Unsupported Instructions: ${instrList}${more}`);
    }
    
    lines.push('');
  });
  
  return lines.join('\n');
}

function formatComparisonOutput(comparison: any[]): string {
  const lines: string[] = [];
  
  lines.push('=== Stack Usage Comparison ===\n');
  
  const increased = comparison.filter(c => c.changeType === 'increased');
  const decreased = comparison.filter(c => c.changeType === 'decreased');
  const unchanged = comparison.filter(c => c.changeType === 'unchanged');
  
  lines.push('Summary:');
  lines.push(`  Increased: ${increased.length}`);
  lines.push(`  Decreased: ${decreased.length}`);
  lines.push(`  Unchanged: ${unchanged.length}`);
  lines.push('');
  
  if (increased.length > 0) {
    lines.push('Increased Stack Usage:');
    increased.forEach(item => {
      lines.push(`  Function [${item.functionIndex}]:`);
      lines.push(`    Old Max Depth: ${item.oldMaxDepth}`);
      lines.push(`    New Max Depth: ${item.newMaxDepth}`);
      lines.push(`    Change: +${item.change}`);
    });
    lines.push('');
  }
  
  if (decreased.length > 0) {
    lines.push('Decreased Stack Usage:');
    decreased.forEach(item => {
      lines.push(`  Function [${item.functionIndex}]:`);
      lines.push(`    Old Max Depth: ${item.oldMaxDepth}`);
      lines.push(`    New Max Depth: ${item.newMaxDepth}`);
      lines.push(`    Change: ${item.change}`);
    });
    lines.push('');
  }
  
  if (unchanged.length > 0) {
    lines.push(`Unchanged Functions (${unchanged.length}):`);
    lines.push(`  [${unchanged.map(c => c.functionIndex).join(', ')}]`);
    lines.push('');
  }
  
  return lines.join('\n');
}
