#!/usr/bin/env node

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'wasm-features':
    require('./commands/wasm-features');
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Available commands:');
    console.error('  wasm-features <wasmFile> [--compare <wasmFile2>] [--json]');
    process.exit(1);
}