# Stellar SDK Example Hub

A collection of examples and tools for working with Stellar and Soroban smart contracts.

## WASM Memory Access Analysis

The `wasm-memory-access` command provides offline analysis of memory access patterns in Soroban contract WASM modules. It scans load and store instructions to build a normalized profile of linear memory usage without executing the contract.

### Usage

```bash
# Analyze a single WASM file
stellar-sdk-example-hub wasm-memory-access contract.wasm

# Output in CSV format
stellar-sdk-example-hub wasm-memory-access contract.wasm -o csv

# Include access-level details in CSV output
stellar-sdk-example-hub wasm-memory-access contract.wasm -o csv --csv-access

# Compare two WASM files
stellar-sdk-example-hub wasm-memory-access original.wasm -c modified.wasm
```

### Output

The tool produces detailed analysis including:

- **Per-function statistics**: Total loads, stores, access counts, read/write ratios
- **Module-level statistics**: Aggregated metrics across all functions
- **Access patterns**: Grouped by opcode and access width
- **Static offset analysis**: Identification of frequently used memory offsets
- **Function classification**: Read-only, write-only, and read-write functions

### JSON Output Format

The default JSON output includes:

```json
{
  "moduleName": "contract",
  "accesses": [
    {
      "functionIndex": 0,
      "basicBlock": 0,
      "instructionIndex": 5,
      "opcode": "i32.load",
      "accessWidth": 4,
      "alignment": 4,
      "staticOffset": 100,
      "memoryIndex": 0,
      "isLoad": true,
      "isStore": false
    }
  ],
  "functionStats": [...],
  "moduleStats": {...}
}
```

### Comparison Mode

When comparing two WASM files, the tool detects:

- Added or removed memory access sites
- Changed load/store operations
- Changed access widths
- Changed static offsets
- Functions with newly introduced memory access

### Limitations

1. **Static Address Detection**: The tool can only identify static offsets that are directly encoded in the WASM instructions. Dynamic addresses (those computed at runtime) will be reported with `staticOffset: null`.

2. **Memory Index**: Most WASM modules use memory index 0. The tool assumes this by default.

3. **Basic Block Detection**: The current implementation uses a simplified approach to basic block detection. More sophisticated analysis would be needed for complex control flow.

4. **WASM Parsing**: The tool relies on the `wasm-parser` library for parsing WASM binaries. Some advanced WASM features might not be fully supported.

### Installation

```bash
npm install -g stellar-sdk-example-hub
```

Or use directly from the repository:

```bash
npm install
npm run build
node dist/index.js wasm-memory-access contract.wasm
```

### Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Test: `npm test`

### License

Apache-2.0