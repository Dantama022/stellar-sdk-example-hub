# WASM Fingerprint Example

This example demonstrates how to compute deterministic fingerprints for Soroban contract WASM artifacts, distinguishing between:

1. Identical binaries (same raw and semantic fingerprints)
2. Semantically equivalent artifacts with non-semantic metadata differences (same semantic fingerprint)
3. Artifacts with meaningful executable-structure changes (different fingerprints)

## Usage

```bash
# Compute fingerprints for a WASM file
npm run example wasm-fingerprint ./path/to/contract.wasm

# Compare two WASM files
npm run example wasm-fingerprint ./path/to/contract1.wasm ./path/to/contract2.wasm

# Output as JSON
npm run example wasm-fingerprint ./path/to/contract.wasm --json
```

## Fingerprint Components

The fingerprint includes:

- **Raw Binary Fingerprint**: SHA-256 hash of the entire WASM binary
- **Semantic Module Fingerprint**: Deterministic hash of normalized semantic structure
- **Type Fingerprint**: Hash of normalized type definitions
- **Import/Export Fingerprint**: Hash of normalized imports and exports
- **Code Fingerprint**: Hash of normalized function bodies
- **Memory/Table Fingerprint**: Hash of normalized memory and table definitions
- **Global Fingerprint**: Hash of normalized global variables
- **Data/Element Fingerprint**: Hash of normalized data and element segments

## Normalization Rules

The semantic fingerprint excludes:

- Custom sections (except those with semantic meaning)
- Debug names and other naming metadata
- Non-deterministic section ordering
- Equivalent numeric encodings where permitted by WASM spec

## Comparison Mode

When comparing two WASM files, the tool reports:

- **Binary-only differences**: Same semantic fingerprint, different raw fingerprint
- **Metadata-only differences**: Same semantic fingerprint, different raw fingerprint
- **Semantic differences**: Different semantic fingerprints

## Limitations

- Does not execute the WASM module
- Custom sections with semantic meaning may be included in fingerprint
- Some WASM features may not be fully normalized
- Fingerprinting is deterministic but not cryptographically secure

## Implementation Details

See `src/wasm-fingerprint.ts` for the core fingerprinting logic.
