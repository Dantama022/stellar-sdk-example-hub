/**
 * Ambient module declarations for the untyped WebAssemblyJS packages that the
 * WASM analysis utilities depend on. The packages ship plain JavaScript, so
 * TypeScript cannot resolve their exports under `noImplicitAny`.
 */
declare module '@webassemblyjs/wasm-parser';
declare module '@webassemblyjs/ast';
declare module 'wasm-parser';
