interface BasicBlock {
  index: number;
  instructions: string[];
  successors: number[];
  predecessors: number[];
}

interface ControlFlowGraph {
  blocks: BasicBlock[];
  entryBlock: number;
}

export class CFGBuilder {
  private func: any;
  private blocks: BasicBlock[] = [];
  private currentBlock: BasicBlock | null = null;
  private blockIndex = 0;

  constructor(func: any) {
    this.func = func;
  }

  build(): ControlFlowGraph {
    this.analyzeFunction();
    return {
      blocks: this.blocks,
      entryBlock: this.blocks.length > 0 ? 0 : -1,
    };
  }

  private analyzeFunction(): void {
    const instructions = this.func.body.instructions || [];
    let pc = 0;

    while (pc < instructions.length) {
      this.startNewBlock(pc);

      const instr = instructions[pc];
      this.addInstructionToCurrentBlock(instr);

      if (this.isControlFlowInstruction(instr)) {
        this.handleControlFlow(instr, pc);
      }

      pc++;
    }

    this.finalizeCurrentBlock();
  }

  private startNewBlock(_startPc: number): void {
    if (this.currentBlock) {
      this.finalizeCurrentBlock();
    }

    this.currentBlock = {
      index: this.blockIndex++,
      instructions: [],
      successors: [],
      predecessors: [],
    };
  }

  private addInstructionToCurrentBlock(instr: any): void {
    if (!this.currentBlock) return;

    this.currentBlock.instructions.push(this.instructionToString(instr));
  }

  private finalizeCurrentBlock(): void {
    if (!this.currentBlock) return;

    this.blocks.push(this.currentBlock);
    this.currentBlock = null;
  }

  private instructionToString(instr: any): string {
    return `${instr.opcode} ${instr.args?.join(', ') || ''}`;
  }

  private isControlFlowInstruction(instr: any): boolean {
    return ['if', 'br', 'br_if', 'br_table', 'return', 'call', 'call_indirect'].includes(
      instr.opcode,
    );
  }

  private handleControlFlow(instr: any, pc: number): void {
    if (!this.currentBlock) return;

    switch (instr.opcode) {
      case 'if':
        this.handleConditionalBranch(instr);
        break;
      case 'br':
      case 'br_if':
        this.handleUnconditionalBranch(instr);
        break;
      case 'br_table':
        this.handleBranchTable(instr);
        break;
      case 'return':
        this.handleReturn();
        break;
      default:
        this.handleOtherControlFlow(instr, pc);
    }

    this.finalizeCurrentBlock();
  }

  private handleConditionalBranch(instr: any): void {
    const block = this.currentBlock;
    if (!block) return;

    block.successors.push(instr.args[0]);
  }

  private handleUnconditionalBranch(instr: any): void {
    const block = this.currentBlock;
    if (!block) return;

    block.successors.push(instr.args[0]);
  }

  private handleBranchTable(instr: any): void {
    const block = this.currentBlock;
    if (!block) return;

    block.successors.push(...instr.args.slice(1));
  }

  private handleReturn(): void {
    // Return implicitly goes to function exit
  }

  private handleOtherControlFlow(_instr: any, _pc: number): void {
    // Handle call, call_indirect, etc.
  }
}
