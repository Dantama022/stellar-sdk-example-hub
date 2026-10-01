# Soroban WASM Function Side-Effect Analysis

A tool for analyzing WebAssembly (WASM) modules to classify functions based on their side effects and dependencies. Particularly useful for Soroban smart contract development to identify pure functions and those that modify contract state.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Basic analysis with JSON output
wasm-side-effects contract.wasm

# Save results to file
wasm-side-effects contract.wasm -o results.json

# CSV output
wasm-side-effects contract.wasm -f csv -o results.csv

# DOT format for visualization
wasm-side-effects contract.wasm -f dot -o graph.dot

# Verbose output
wasm-side-effects contract.wasm -v
```

## Classification Rules

Functions are classified according to the following rules:

1. **pure**:
   - No memory writes
   - No mutable global writes
   - No table mutations
   - No indirect calls
   - No imported function calls
   - No calls to non-pure functions

2. **read-only**:
   - May read memory or mutable globals
   - No writes to memory or mutable globals
   - No table mutations
   - No indirect calls
   - No imported function calls
   - May call other read-only or pure functions

3. **state-mutating**:
   - Writes to memory
   - OR writes to mutable globals
   - OR mutates tables
   - OR uses indirect calls

4. **externally-dependent**:
   - Calls imported functions
   - No other state mutations

5. **effectful**:
   - Has transitive side effects through callee functions
   - OR combines multiple side effect types

6. **unknown**:
   - Uses indirect calls where targets cannot be statically determined
   - OR other cases where analysis cannot be completed

## Output Formats

### JSON
Default output format. Contains:
- Full analysis of each function
- Side effect evidence
- Call graph information
- Summary statistics

### CSV
Flattened per-function classification with all evidence fields.

### DOT
Graphviz DOT format for visualizing the function call graph with color-coded classifications.

## Example Output

```json
{
  "functions": [
    {
      "name": "add",
      "classification": "pure",
      "evidence": {
        "memoryWrites": false,
        "memoryReads": false,
        "mutableGlobalWrites": [],
        "mutableGlobalReads": [],
        "tableMutations": false,
        "importedCalls": [],
        "indirectCalls": false,
        "trappingOps": false,
        "transitiveEffects": []
      },
      "callees": [],
      "callers": []
    }
  ],
  "summary": {
    "total": 1,
    "pure": 1,
    "readOnly": 0,
    "stateMutating": 0,
    "externallyDependent": 0,
    "effectful": 0,
    "unknown": 0,
    "transitiveEffectful": 0
  }
}
```

## Implementation Details

The analyzer performs two passes over the WASM module:

1. **First Pass**: Analyzes each function individually to detect direct side effects
2. **Second Pass**: Propagates side effect information through the call graph to identify transitive effects

The analysis is conservative - when in doubt, functions are classified as having potential side effects rather than being incorrectly marked as pure.

## Limitations

- Does not analyze control flow (all paths are considered)
- Indirect calls are treated conservatively
- Imported function effects are assumed to be externally dependent
- Does not perform inter-procedural data flow analysis

## License

Apache-2.0
