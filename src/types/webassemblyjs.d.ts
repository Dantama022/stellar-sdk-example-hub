/**
 * Ambient declarations for the `@webassemblyjs` packages.
 *
 * The packages do not ship TypeScript type declarations, so the modules are
 * declared as `any` here. This keeps `npm run typecheck` working without
 * adding another dependency to the repository.
 */

declare module '@webassemblyjs/wasm-parser' {
  export function decode(buffer: Uint8Array, options?: Record<string, unknown>): any;
  export function parse(buffer: Uint8Array): any;
}

declare module '@webassemblyjs/ast' {
  export function traverse(ast: any, visitors: Record<string, (...args: any[]) => void>): void;
}
