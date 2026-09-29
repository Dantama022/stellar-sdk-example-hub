import { AnalysisResult } from './analyzer';

export class UnreachableAnalyzer {
  private cfg: any;

  constructor(cfg: any) {
    this.cfg = cfg;
  }

  analyze(): AnalysisResult {
    const functions = this.cfg.map((func: any) => this.analyzeFunction(func));
    const metrics = this.calculateMetrics(functions);

    return {
      functions,
      metrics
    };
  }

  private analyzeFunction(func: any): any {
    const reachable = new Set<number>();
    const queue = [func.entry];
    reachable.add(func.entry);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const block = func.blocks[current];

      if (block.successors) {
        block.successors.forEach((successor: number) => {
          if (!reachable.has(successor)) {
            reachable.add(successor);
            queue.push(successor);
          }
        });
      }
    }

    const unreachableRegions = this.findUnreachableRegions(func, reachable);
    const blocks = func.blocks.map((block: any, index: number) => ({
      index,
      instructions: block.instructions.length,
      reachable: reachable.has(index),
      reason: this.determineReason(block, reachable)
    }));

    return {
      index: func.index,
      name: func.name,
      blocks,
      unreachableRegions,
      density: this.calculateDensity(blocks)
    };
  }

  private findUnreachableRegions(func: any, reachable: Set<number>): any[] {
    const regions: any[] = [];
    let currentRegion: any = null;

    func.blocks.forEach((block: any, index: number) => {
      if (!reachable.has(index)) {
        if (!currentRegion) {
          currentRegion = {
            start: index,
            end: index,
            reason: this.determineReason(block, reachable)
          };
        } else {
          currentRegion.end = index;
        }
      } else {
        if (currentRegion) {
          regions.push(currentRegion);
          currentRegion = null;
        }
      }
    });

    if (currentRegion) {
      regions.push(currentRegion);
    }

    return regions;
  }

  private determineReason(block: any, reachable: Set<number>): string {
    const lastInst = block.instructions[block.instructions.length - 1];

    if (lastInst.type === 'Return') {
      return 'unconditional_return';
    } else if (lastInst.type === 'Unreachable') {
      return 'unreachable_instruction';
    } else if (lastInst.type === 'Br' && lastInst.target === block.index + 1) {
      return 'unconditional_branch';
    } else if (!reachable.has(block.index + 1)) {
      return 'structural_termination';
    }

    return 'unknown';
  }

  private calculateDensity(blocks: any[]): number {
    const total = blocks.length;
    const unreachable = blocks.filter(b => !b.reachable).length;
    return total > 0 ? unreachable / total : 0;
  }

  private calculateMetrics(functions: any[]): any {
    const totalBlocks = functions.reduce((sum, func) => sum + func.blocks.length, 0);
    const reachableBlocks = functions.reduce((sum, func) =>
      sum + func.blocks.filter(b => b.reachable).length, 0);
    const unreachableBlocks = totalBlocks - reachableBlocks;

    const totalInstructions = functions.reduce((sum, func) =>
      sum + func.blocks.reduce((bSum, block) => bSum + block.instructions, 0), 0);
    const reachableInstructions = functions.reduce((sum, func) =>
      sum + func.blocks.filter(b => b.reachable).reduce((bSum, block) =>
        bSum + block.instructions, 0), 0);
    const unreachableInstructions = totalInstructions - reachableInstructions;

    const functionsWithUnreachable = functions.filter(f =>
      f.unreachableRegions.length > 0).length;

    const largestUnreachableRegion = functions.reduce((max, func) =>
      Math.max(max, func.unreachableRegions.reduce((rMax, region) =>
        Math.max(rMax, region.end - region.start + 1), 0)), 0);

    return {
      totalBlocks,
      reachableBlocks,
      unreachableBlocks,
      totalInstructions,
      reachableInstructions,
      unreachableInstructions,
      unreachablePercentage: (unreachableInstructions / totalInstructions) * 100,
      functionsWithUnreachable,
      largestUnreachableRegion
    };
  }

  compare(compareCfg: any): any {
    const currentFunctions = this.cfg;
    const compareFunctions = compareCfg;

    const comparison: any = {
      newlyUnreachable: 0,
      newlyReachable: 0,
      changedBoundaries: 0,
      functionsWithNewUnreachable: 0
    };

    currentFunctions.forEach((func: any, index: number) => {
      const compareFunc = compareFunctions[index];
      if (!compareFunc) return;

      const currentUnreachable = func.blocks.filter(b => !b.reachable);
      const compareUnreachable = compareFunc.blocks.filter(b => !b.reachable);

      comparison.newlyUnreachable += currentUnreachable.length - compareUnreachable.length;
      comparison.newlyReachable += compareUnreachable.length - currentUnreachable.length;

      if (currentUnreachable.length > compareUnreachable.length) {
        comparison.functionsWithNewUnreachable++;
      }
    });

    return comparison;
  }
}