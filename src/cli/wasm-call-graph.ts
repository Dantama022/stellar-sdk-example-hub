import { Command } from 'commander';
import { readFileSync } from 'fs';
import { parse } from 'wasm-parser';
import { CallGraphBuilder, CallGraph } from '../analyzer/call-graph-builder';

export function setupWasmCallGraphCommand() {
  const program = new Command('wasm-call-graph')
    .description('Analyze WASM function call graph relationships')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|text|dot)', 'text')
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

        // Build call graph
        const builder = new CallGraphBuilder(wasmModule);
        const callGraph = builder.build();

        // Output results
        if (options.output === 'json') {
          console.log(formatJsonOutput(callGraph));
        } else if (options.output === 'dot') {
          console.log(formatDotOutput(callGraph));
        } else {
          console.log(formatTextOutput(callGraph));
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

function formatJsonOutput(callGraph: CallGraph): string {
  return JSON.stringify(callGraph, null, 2);
}

function formatTextOutput(callGraph: CallGraph): string {
  const lines: string[] = [];
  
  lines.push('=== WASM Call Graph Analysis ===\n');
  
  // Statistics
  lines.push('Statistics:');
  lines.push(`  Total Functions: ${callGraph.statistics.totalFunctions}`);
  lines.push(`  Total Resolved Call Edges: ${callGraph.statistics.totalResolvedEdges}`);
  lines.push(`  Total Unresolved References: ${callGraph.statistics.totalUnresolvedReferences}`);
  
  if (callGraph.statistics.maxOutgoingCalls.functionIndex >= 0) {
    const node = callGraph.nodes.find(n => n.index === callGraph.statistics.maxOutgoingCalls.functionIndex);
    lines.push(`  Max Outgoing Calls: Function ${callGraph.statistics.maxOutgoingCalls.functionIndex} (${node?.name}) with ${callGraph.statistics.maxOutgoingCalls.count} calls`);
  }
  
  if (callGraph.statistics.maxIncomingCalls.functionIndex >= 0) {
    const node = callGraph.nodes.find(n => n.index === callGraph.statistics.maxIncomingCalls.functionIndex);
    lines.push(`  Max Incoming Calls: Function ${callGraph.statistics.maxIncomingCalls.functionIndex} (${node?.name}) with ${callGraph.statistics.maxIncomingCalls.count} calls`);
  }
  
  lines.push(`  Graph Depth: ${callGraph.statistics.maxDepth}`);
  lines.push(`  Functions with No Incoming Calls: ${callGraph.statistics.functionsWithNoIncoming.length}`);
  lines.push(`  Functions with No Outgoing Calls: ${callGraph.statistics.functionsWithNoOutgoing.length}`);
  lines.push(`  Recursive Functions: ${callGraph.statistics.recursiveFunctions.length}`);
  
  if (callGraph.statistics.recursiveFunctions.length > 0) {
    lines.push(`    Indices: [${callGraph.statistics.recursiveFunctions.join(', ')}]`);
  }
  
  lines.push('');
  
  // Function details
  lines.push('Functions:');
  callGraph.nodes.forEach(node => {
    lines.push(`  [${node.index}] ${node.name} (${node.type})`);
    
    if (node.exportNames && node.exportNames.length > 0) {
      lines.push(`    Exported as: ${node.exportNames.join(', ')}`);
    }
    
    if (node.importModule && node.importName) {
      lines.push(`    Import: ${node.importModule}.${node.importName}`);
    }
    
    if (node.outgoingCalls.length > 0) {
      lines.push(`    Calls: [${node.outgoingCalls.join(', ')}]`);
    }
    
    if (node.incomingCalls.length > 0) {
      lines.push(`    Called by: [${node.incomingCalls.join(', ')}]`);
    }
    
    if (node.indirectCalls > 0) {
      lines.push(`    Indirect calls: ${node.indirectCalls}`);
    }
    
    if (node.unresolvedCalls > 0) {
      lines.push(`    Unresolved calls: ${node.unresolvedCalls}`);
    }
    
    lines.push('');
  });
  
  // Entry points (functions with no incoming calls)
  if (callGraph.statistics.functionsWithNoIncoming.length > 0) {
    lines.push('Entry Points (no incoming calls):');
    callGraph.statistics.functionsWithNoIncoming.forEach(idx => {
      const node = callGraph.nodes.find(n => n.index === idx);
      if (node) {
        lines.push(`  [${idx}] ${node.name}`);
      }
    });
    lines.push('');
  }
  
  // Leaf functions (functions with no outgoing calls)
  if (callGraph.statistics.functionsWithNoOutgoing.length > 0) {
    lines.push('Leaf Functions (no outgoing calls):');
    callGraph.statistics.functionsWithNoOutgoing.forEach(idx => {
      const node = callGraph.nodes.find(n => n.index === idx);
      if (node) {
        lines.push(`  [${idx}] ${node.name}`);
      }
    });
    lines.push('');
  }
  
  return lines.join('\n');
}

function formatDotOutput(callGraph: CallGraph): string {
  const lines: string[] = [];
  
  lines.push('digraph CallGraph {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box];');
  lines.push('');
  
  // Node definitions
  callGraph.nodes.forEach(node => {
    let label = `${node.index}: ${node.name}`;
    let style = 'solid';
    let color = 'black';
    
    if (node.type === 'exported') {
      color = 'blue';
      style = 'bold';
      if (node.exportNames && node.exportNames.length > 0) {
        label += `\\nexported as: ${node.exportNames.join(', ')}`;
      }
    } else if (node.type === 'imported') {
      color = 'green';
      style = 'dashed';
    }
    
    lines.push(`  node_${node.index} [label="${label}", color="${color}", style="${style}"];`);
  });
  
  lines.push('');
  
  // Edge definitions
  callGraph.edges.forEach(edge => {
    const style = edge.callType === 'indirect' ? 'dashed' : 'solid';
    const label = edge.count > 1 ? ` [label="${edge.count}"]` : '';
    lines.push(`  node_${edge.from} -> node_${edge.to} [style="${style}"${label}];`);
  });
  
  lines.push('}');
  
  return lines.join('\n');
}
