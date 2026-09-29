# WASM Branch Condition Analysis Example

This example demonstrates offline analysis of Soroban contract WASM files to identify and analyze conditional branch decisions.

## Usage

```bash
# Analyze a WASM file
node examples/wasm-branches/wasm-branches.js path/to/contract.wasm

# Output formats
node examples/wasm-branches/wasm-branches.js path/to/contract.wasm --json > analysis.json
node examples/wasm-branches/wasm-branches.js path/to/contract.wasm --csv > branches.csv
node examples/wasm-branches/wasm-branches.js path/to/contract.wasm --dot > graph.dot
```

## Features

- Identifies all conditional branch sites (`br_if`, `if`, branch-tables)
- Traces branch conditions back to their sources
- Classifies branches by condition type
- Provides statistical analysis of control flow
- Supports multiple output formats

## Output

The tool generates:
- Branch site inventory with condition details
- Statistical summary of branch types
- Control-flow graph visualization (DOT format)
- Conditional branch density metrics

## Implementation Details

The analyzer uses:
- WebAssembly binary format parsing
- Control-flow graph construction
- Conservative static analysis for condition resolution
- Data-flow tracking for operand tracing

See `src/wasm-analyzer.ts` for implementation details.
```