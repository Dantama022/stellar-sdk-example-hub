# Soroban Contract WASM Embedded String Analysis Example

An offline static analysis tool for extracting, categorizing, filtering, and comparing embedded strings in Soroban contract WASM artifacts.

## Features

- **Offline Static Analysis**: Never executes the WASM binary.
- **WASM Parsing**: Inspects standard data segments and custom sections.
- **Encoding Detection**: Classifies strings as ASCII or UTF-8, and detects null-termination vs length-delimitation.
- **Deterministic Categorization**: Automatically identifies error messages, URLs, identifiers, paths, and numeric strings.
- **Statistical Metrics**: Calculates total strings, unique counts, byte sizes, averages, maximums, and printable percentage.
- **Filtering & Grouping**: Filter by min/max length, section, encoding, search pattern, and case sensitivity. Group by section, encoding, length range, and category.
- **Artifact Comparison**: Compare two contract versions to detect added, removed, moved, and modified strings.
- **Flexible Output**: Supports JSON and CSV output modes.

## CLI Usage

```bash
stellar-sdk-example-hub wasm-strings contract.wasm --json
stellar-sdk-example-hub wasm-strings contract.wasm --csv > strings.csv
stellar-sdk-example-hub wasm-strings --compare contract_v1.wasm contract_v2.wasm --json
```
