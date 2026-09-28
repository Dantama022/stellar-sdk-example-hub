import { FunctionAnalysis } from './analyzer';

export class CFGBuilder {
  private ast: any;

  constructor(ast: any) {
    this.ast = ast;
  }

  build(): any {
    const functions = this.ast.body.filter((node: any) => node.type === 'Function');
    return functions.map((func: any) => this.buildFunctionCFG(func));
  }

  private buildFunctionCFG(func: any): any {
    const blocks = this.getBasicBlocks(func);
    const cfg: any = {
      entry: this.findEntryBlock(blocks),
      blocks: blocks.map((block: any, index: number) => ({
        index,
        instructions: block.instructions,
        successors: this.findSuccessors(block),
        predecessors: []
      }))
    };

    this.linkBlocks(cfg);
    return cfg;
  }

  private getBasicBlocks(func: any): any[] {
    return func.body;
  }

  private findEntryBlock(blocks: any[]): number {
    return 0;
  }

  private findSuccessors(block: any): number[] {
    const successors: number[] = [];
    const lastInst = block.instructions[block.instructions.length - 1];

    if (lastInst.type === 'Br' || lastInst.type === 'BrIf') {
      successors.push(lastInst.target);
    } else if (lastInst.type === 'Return') {
      return successors;
    } else if (lastInst.type === 'Unreachable') {
      return successors;
    }

    successors.push(block.index + 1);
    return successors;
  }

  private linkBlocks(cfg: any): void {
    cfg.blocks.forEach((block: any) => {
      block.successors.forEach((successor: number) => {
        const successorBlock = cfg.blocks[successor];
        if (successorBlock) {
          successorBlock.predecessors.push(block.index);
        }
      });
    });
  }
}