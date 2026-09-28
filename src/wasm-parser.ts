import { readFileSync } from 'fs';
import { parse } from 'wasm-parser';

export class WASMParser {
  private buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  parse(): any {
    return parse(this.buffer);
  }

  getFunctionBodies(ast: any): any[] {
    return ast.body.filter((node: any) => node.type === 'Function');
  }

  getBasicBlocks(functionBody: any): any[] {
    return functionBody.body;
  }
}