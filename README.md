# Soroban WASM Unreachable Path Analyzer

Static analysis tool for detecting unreachable code in Soroban WASM artifacts.

## Features
- Identifies unreachable basic blocks and instructions
- Classifies termination reasons (returns, branches, traps)
- Supports JSON and CSV output
- Comparison mode for artifact diffing
- No WASM execution required

## Installation

```bash
npm install -g soroban-wasm-unreachable
```

## Usage

### Basic Analysis
```bash
wasm-unreachable -f path/to/contract.wasm
```

### Comparison Mode
```bash
wasm-unreachable -f current.wasm -c previous.wasm
```

### Output Formats
```bash
wasm-unreachable -f contract.wasm -o json
wasm-unreachable -f contract.wasm -o csv
```

## Output

### JSON Format
```json
{
  "functions": [...],
  "metrics": {
    "totalBlocks": 42,
    "reachableBlocks": 38,
    "unreachableBlocks": 4,
    "unreachablePercentage": 9.52
  }
}
```

### CSV Format
```csv
Function Index,Function Name,Block Index,Reachable,Reason,Start Instruction,End Instruction
0,main,3,false,unconditional_return,0,5
```

## Metrics

- Total reachable/unreachable blocks
- Total reachable/unreachable instructions
- Unreachable code percentage
- Functions containing unreachable regions
- Largest unreachable region

## License
MIT