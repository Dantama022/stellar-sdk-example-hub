# Stellar SDK Example Hub

A collection of examples demonstrating how to use the Stellar SDK and Soroban tools.

## WASM Name Section Analysis

The `wasm-names` command analyzes WASM name section metadata in Soroban contracts without executing the contract. This is useful for debugging contract artifacts and understanding compiler-generated modules.

### Usage

```bash
# Analyze a single WASM file
stellar-sdk-example-hub wasm-names <wasmFile>

# Output in JSON format
stellar-sdk-example-hub wasm-names <wasmFile> --json

# Compare two WASM files
stellar-sdk-example-hub wasm-names <wasmFile1> --compare <wasmFile2>
```

### Examples

#### Single File Analysis

```bash
stellar-sdk-example-hub wasm-names contract.wasm
```

Output:
```
WASM Name Section Analysis
===========================
Total functions: 10
Named functions: 8
Unnamed functions: 2
Functions with local names: 5
Total named locals: 15

Function Names:
  [0] initialize
  [1] handle
  [2] helper_function
  ...

Unnamed Functions:
  [8]
  [9]

Local Names:
  Function [0]:
    [0] param1
    [1] param2
  Function [1]:
    [0] input
    [1] output
    ...

Functions with Most Named Locals:
  [1] handle: 5 locals
```

#### JSON Output

```bash
stellar-sdk-example-hub wasm-names contract.wasm --json
```

Output:
```json
{
  "hasNameSection": true,
  "totalFunctions": 10,
  "namedFunctions": [
    {"index": 0, "name": "initialize"},
    {"index": 1, "name": "handle"}
  ],
  "unnamedFunctions": [8, 9],
  "functionsWithLocals": [0, 1, 2, 3, 4],
  "functionLocals": [
    {
      "functionIndex": 0,
      "locals": [
        {"index": 0, "name": "param1"},
        {"index": 1, "name": "param2"}
      ]
    }
  ],
  "totalNamedLocals": 15,
  "functionsWithMostLocals": [
    {"functionIndex": 1, "name": "handle", "localCount": 5}
  ]
}
```

#### Comparison Mode

```bash
stellar-sdk-example-hub wasm-names contract-v1.wasm --compare contract-v2.wasm
```

Output:
```
WASM Name Section Comparison
=============================

Added Function Names:
  [10] new_function

Removed Function Names:
  [5] old_function

Renamed Functions:
  [3] process_input -> handle_input

Added Local Names:
  Function [1], Local [2] new_param

Removed Local Names:
  Function [2], Local [1] old_param

Changed Local Names:
  Function [0], Local [0] param_a -> param_alpha
```

### Features

- Detects and parses standard WASM `name` custom section
- Extracts function index-to-name mappings
- Extracts local names grouped by function index
- Reports named and unnamed functions separately
- Handles modules without name sections gracefully
- Supports JSON output mode
- Comparison mode for detecting changes between WASM artifacts
- Preserves raw indexes in all outputs
- Handles malformed name sections without crashing
- Completely offline analysis (never executes WASM)

### Notes

- The analysis is performed on the raw WASM binary without loading or executing the module
- Function and local indexes are preserved as numeric values in all outputs
- In comparison mode, renamed entities can be traced to their original WASM indexes
- Partial naming metadata (some functions/names missing) is handled correctly
