# Soroban WASM Dominator Tree Analysis

## Overview
This tool analyzes the control-flow structure of Soroban WASM contracts by constructing control-flow graphs and calculating dominator relationships without executing the contract.

## Dominance Model
Dominance relationships reveal which basic blocks must be executed before reaching another block. The analysis identifies:

- **Immediate dominators**: The single block that dominates another without being dominated by any other block
- **Dominator depth**: Hierarchical distance from entry block
- **Loop headers**: Blocks that dominate loop bodies
- **Unreachable code**: Blocks with no control-flow paths

## Analysis Features
- **Control-flow graph construction**: Identifies basic blocks and control-flow edges
- **Dominator calculation**: Uses Lengauer-Tarjan algorithm for efficient computation
- **Metrics collection**: Tracks depth, coverage, and structural properties
- **Comparison mode**: Detects changes between WASM artifacts
- **Output formats**: JSON for programmatic use, DOT for visualization

## Limitations
- Does not handle dynamic control flow (e.g., indirect calls)
- Assumes static analysis of compiled WASM
- May produce false positives for complex control flow patterns

## Usage
```bash
# Basic analysis
stellar-sdk-example-hub wasm-dominators contract.wasm

# JSON output
stellar-sdk-example-hub wasm-dominators contract.wasm --output json

# DOT graph output
stellar-sdk-example-hub wasm-dominators contract.wasm --output dot

# Comparison mode
stellar-sdk-example-hub wasm-dominators contract1.wasm --compare contract2.wasm
```

## Example Output
```json
{
  "functions": [
    {
      "index": 0,
      "name": "main",
      "cfg": {
        "blocks": [
          {
            "index": 0,
            "instructions": ["i32.const 42", "i32.store"],
            "dominators": [0],
            "immediateDominator": null,
            "depth": 0,
            "dominatedBlocks": 3
          }
        ],
        "edges": [
          {"from": 0, "to": 1, "type": "sequential"}
        ]
      },
      "metrics": {
        "maxDepth": 2,
        "entryCoverage": 1,
        "loopHeaders": [],
        "unreachableBlocks": []
      }
    }
  ]
}
```

## Development
```bash
# Run tests
npm test

# Build project
npm run build

# Add test fixtures
cp test/fixtures/template.wasm test/fixtures/new-test.wasm
```