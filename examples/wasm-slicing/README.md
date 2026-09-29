# WASM Program Slicing Analysis Example

This example demonstrates offline WASM program slicing analysis for Soroban smart contracts.

## Overview

The `wasm-slice` CLI tool analyzes compiled WASM modules to identify and extract relevant code segments based on control-flow and data-flow dependencies. This helps isolate the minimal set of instructions that influence a specific target value or operation.

## Features

- **Target Selection**: Choose targets by function index, basic block, instruction index, local variable, or return value
- **Slice Modes**:
  - Backward: Identify instructions that may influence a target
  - Forward: Identify values influenced by a selected definition
  - Bidirectional: Combine both approaches
- **Dependency Tracking**:
  - Locals, parameters, constants, globals
  - Memory loads (when statically resolvable)
  - Function calls and indirect calls
  - Control-flow dependencies
- **Output Formats**:
  - Normalized instruction list
  - DOT graph visualization
  - JSON format
- **Metrics**: Detailed statistics about the slice
- **Comparison Mode**: Compare two WASM artifacts

## Installation

```bash
npm install
```

## Usage

```bash
# Basic backward slice
node examples/wasm-slicing/wasm-slice.js analyze --file contract.wasm --target function:0 --mode backward

# Forward slice with JSON output
node examples/wasm-slicing/wasm-slice.js analyze --file contract.wasm --target instruction:123 --mode forward --output json

# Compare two WASM artifacts
node examples/wasm-slicing/wasm-slice.js compare --file1 old.wasm --file2 new.wasm --target function:0
```

## Example Contracts

The `contracts/` directory contains example Soroban contracts demonstrating different slicing scenarios:

- `simple-arithmetic.wasm`: Basic arithmetic operations
- `multi-function.wasm`: Contract with multiple functions and cross-boundary dependencies
- `with-loops.wasm`: Contract demonstrating loop handling

## Implementation Details

The analyzer works by:

1. Parsing the WASM module to build a control-flow graph
2. Constructing def-use relationships for all instructions
3. Performing data-flow analysis to track dependencies
4. Applying slice criteria to determine relevant instructions
5. Generating the slice based on the selected mode
6. Calculating metrics and producing output

## License

MIT
