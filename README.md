# Stellar SDK Example Hub

A collection of examples and utilities for working with the Stellar network and Soroban smart contracts.

## WASM Feature Usage Analysis

The `wasm-features` CLI tool analyzes WebAssembly (WASM) binaries to detect and report usage of various WASM features. This is particularly useful for Soroban contract developers who need to understand which WASM capabilities their compiled contracts utilize.

### Features Detected

The analyzer can detect the following WASM feature categories:

- **Bulk Memory Operations**: `memory.copy`, `memory.fill`, `memory.init`, `data.drop`
- **Reference Types**: `externref`, `anyref`, `func.ref`, `ref.null`, etc.
- **Table Instructions**: `table.get`, `table.set`, `table.init`, `table.copy`, etc.
- **Multiple Tables**: Detection of modules with more than one table
- **Memory Advanced Features**: Advanced memory-related operations
- **Multiple Memories**: Detection of modules with more than one memory
- **SIMD/Vector Instructions**: Vector operations (e.g., `i8x16.shuffle`)
- **Exception Handling**: `try`, `catch`, `throw`, etc.
- **Typed Function References**: Function references with specific types
- **Indirect Calls**: `call_indirect` instructions
- **Memory Initialization**: `memory.init` instructions
- **Data Segment Operations**: Operations on data segments
- **Element Segment Operations**: Operations on element segments
- **Shared Memory**: Thread-related features
- **Atomics**: Atomic operations

### Limitations

1. The analyzer only examines the static structure of the WASM module. It does not execute the WASM code.
2. Some features may not be detectable from the binary representation alone (e.g., certain runtime behaviors).
3. The tool reports features that are present in the module but does not indicate whether a particular runtime supports them.
4. Unknown opcodes or feature encodings are handled gracefully but may not be reported.

### Usage

#### Basic Analysis

```bash
stellar-sdk-example-hub wasm-features <path-to-wasm-file>
```

Example output:
```
WASM Feature Analysis:
Detected Features:
  bulk-memory:
    Occurrences: 2
    Functions: function 0, function 1
    Locations: function 0 (offset 10), function 1 (offset 25)
  reference-types:
    Occurrences: 1
    Functions: function 2
    Locations: function 2 (offset 5)

Undetected Features:
simd, exceptions, multiple-memories, shared-memory

Unknown Features:
None
```

#### JSON Output

```bash
stellar-sdk-example-hub wasm-features <path-to-wasm-file> --json
```

#### Comparison Mode

Compare two WASM files to see differences in feature usage:

```bash
stellar-sdk-example-hub wasm-features <path-to-wasm-file1> --compare <path-to-wasm-file2>
```

Example output:
```
Comparison Results:
New features: simd, exceptions
Removed features: None
Changed counts:
  bulk-memory: 2 -> 5
  reference-types: 1 -> 3
```

#### JSON Comparison Output

```bash
stellar-sdk-example-hub wasm-features <path-to-wasm-file1> --compare <path-to-wasm-file2> --json
```

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Dantama022/stellar-sdk-example-hub.git
   cd stellar-sdk-example-hub
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Link the package for global CLI usage:
   ```bash
   npm link
   ```

### Development

#### Running Tests

```bash
npm test
```

#### Adding Fixtures

Test fixtures for WASM modules should be placed in `test/fixtures/wasm/`. Each fixture should be a valid WASM binary that demonstrates specific feature usage.

### Contributing

Contributions are welcome! Please ensure:

1. All tests pass
2. New features include appropriate test coverage
3. Documentation is updated for any new functionality
4. Code follows the existing style and conventions

### License

MIT