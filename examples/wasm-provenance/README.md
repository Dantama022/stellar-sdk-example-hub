# WASM Provenance Analyzer

Analyzes Soroban contract WASM artifacts to extract compiler provenance metadata without executing the contract.

## Usage

```bash
# Analyze a single WASM file
npm run example wasm-provenance ./path/to/contract.wasm

# Compare two WASM files
npm run example wasm-provenance ./path/to/contract1.wasm ./path/to/contract2.wasm

# JSON output
npm run example wasm-provenance ./path/to/contract.wasm --json
```

## Features

- Detects standard producer metadata (rustc, soroban-cli, wasm-opt, etc.)
- Normalizes producer information into structured format
- Reports module statistics (function count, size, etc.)
- Supports comparison mode for detecting provenance changes
- Handles missing/incomplete metadata gracefully
- Completely offline operation

## Limitations

- Only analyzes producer metadata, not contract execution
- Requires WASM files with producer sections
- Some toolchains may not include standard producer records

## Producer Categories

- **compiler**: Language compilers (rustc, soroban-cli)
- **linker**: Binary tools (wasm-opt, lld)
- **language**: High-level language toolchains
- **other**: Any other producer tools

## Example Output

```json
{
  "file": "contract.wasm",
  "moduleInfo": {
    "version": 1,
    "functionCount": 42,
    "importCount": 5,
    "exportCount": 10,
    "codeSize": 1024,
    "hasCustomSections": true
  },
  "producers": [
    {
      "category": "compiler",
      "name": "rustc",
      "version": "1.75.0",
      "fields": {
        "build": "2024-01-01",
        "target": "wasm32-unknown-unknown"
      }
    },
    {
      "category": "linker",
      "name": "wasm-opt",
      "version": "116.0.0",
      "fields": {}
    }
  ],
  "fingerprint": "sha256-..."
}
```