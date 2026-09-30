/**
 * WASM Function Reachability Analyzer
 * Determines which functions are reachable from exported entry points
 */

import { CallGraph, CallGraphNode } from './call-graph-builder';

export interface ReachabilityResult {
  reachableFunctions: number[];
  unreachableFunctions: number[];
  reachableFromMultipleRoots: Array<{
    functionIndex: number;
    roots: number[];
  }>;
  rootsWithNoOutgoing: number[];
  reachabilityMap: Map<number, {
    isReachable: boolean;
    reachedFrom: number[];
    depth: number;
  }>;
  statistics: {
    totalFunctions: number;
    reachableFunctions: number;
    unreachableFunctions: number;
    averageDepth: number;
    maxDepth: number;
  };
}

export class ReachabilityAnalyzer {
  private callGraph: CallGraph;
  private rootFunctions: number[];

  constructor(callGraph: CallGraph, customRoots?: number[]) {
    this.callGraph = callGraph;
    
    // Use exported functions as default roots
    if (customRoots && customRoots.length > 0) {
      this.rootFunctions = customRoots;
    } else {
      this.rootFunctions = callGraph.nodes
        .filter(node => node.type === 'exported')
        .map(node => node.index);
    }
  }

  analyze(): ReachabilityResult {
    const reachabilityMap = new Map<number, {
      isReachable: boolean;
      reachedFrom: number[];
      depth: number;
    }>();

    // Initialize all functions as unreachable
    this.callGraph.nodes.forEach(node => {
      reachabilityMap.set(node.index, {
        isReachable: false,
        reachedFrom: [],
        depth: -1
      });
    });

    // Mark root functions as reachable at depth 0
    this.rootFunctions.forEach(rootIndex => {
      const entry = reachabilityMap.get(rootIndex);
      if (entry) {
        entry.isReachable = true;
        entry.depth = 0;
      }
    });

    // Traverse from each root
    this.rootFunctions.forEach(rootIndex => {
      this.traverseFrom(rootIndex, reachabilityMap, new Set());
    });

    // Compile results
    const reachableFunctions: number[] = [];
    const unreachableFunctions: number[] = [];
    const reachableFromMultiple: Array<{ functionIndex: number; roots: number[] }> = [];

    this.callGraph.nodes.forEach(node => {
      const entry = reachabilityMap.get(node.index);
      if (entry) {
        if (entry.isReachable) {
          reachableFunctions.push(node.index);
          
          if (entry.reachedFrom.length > 1) {
            reachableFromMultiple.push({
              functionIndex: node.index,
              roots: entry.reachedFrom.sort((a, b) => a - b)
            });
          }
        } else {
          unreachableFunctions.push(node.index);
        }
      }
    });

    // Sort results
    reachableFunctions.sort((a, b) => a - b);
    unreachableFunctions.sort((a, b) => a - b);
    reachableFromMultiple.sort((a, b) => a.functionIndex - b.functionIndex);

    // Find roots with no outgoing calls
    const rootsWithNoOutgoing = this.rootFunctions.filter(rootIndex => {
      const node = this.callGraph.nodes.find(n => n.index === rootIndex);
      return node && node.outgoingCalls.length === 0;
    }).sort((a, b) => a - b);

    // Calculate statistics
    const statistics = this.calculateStatistics(reachabilityMap);

    return {
      reachableFunctions,
      unreachableFunctions,
      reachableFromMultipleRoots: reachableFromMultiple,
      rootsWithNoOutgoing,
      reachabilityMap,
      statistics
    };
  }

  private traverseFrom(
    currentIndex: number,
    reachabilityMap: Map<number, { isReachable: boolean; reachedFrom: number[]; depth: number }>,
    visited: Set<number>
  ): void {
    if (visited.has(currentIndex)) return;
    visited.add(currentIndex);

    const currentNode = this.callGraph.nodes.find(n => n.index === currentIndex);
    if (!currentNode) return;

    const currentEntry = reachabilityMap.get(currentIndex);
    if (!currentEntry) return;

    const currentDepth = currentEntry.depth;
    const rootIndex = this.findRoot(currentIndex, reachabilityMap);

    currentNode.outgoingCalls.forEach(targetIndex => {
      const targetEntry = reachabilityMap.get(targetIndex);
      if (targetEntry) {
        targetEntry.isReachable = true;
        
        // Track which root this came from
        if (rootIndex !== null && !targetEntry.reachedFrom.includes(rootIndex)) {
          targetEntry.reachedFrom.push(rootIndex);
        }
        
        // Update depth if this is a shorter path
        const newDepth = currentDepth + 1;
        if (targetEntry.depth === -1 || newDepth < targetEntry.depth) {
          targetEntry.depth = newDepth;
        }
        
        this.traverseFrom(targetIndex, reachabilityMap, visited);
      }
    });
  }

  private findRoot(
    functionIndex: number,
    reachabilityMap: Map<number, { isReachable: boolean; reachedFrom: number[]; depth: number }>
  ): number | null {
    if (this.rootFunctions.includes(functionIndex)) {
      return functionIndex;
    }

    const entry = reachabilityMap.get(functionIndex);
    if (entry && entry.reachedFrom.length > 0) {
      return entry.reachedFrom[0];
    }

    return null;
  }

  private calculateStatistics(
    reachabilityMap: Map<number, { isReachable: boolean; reachedFrom: number[]; depth: number }>
  ): ReachabilityResult['statistics'] {
    let totalDepth = 0;
    let reachableCount = 0;
    let maxDepth = 0;

    reachabilityMap.forEach(entry => {
      if (entry.isReachable) {
        reachableCount++;
        if (entry.depth >= 0) {
          totalDepth += entry.depth;
          maxDepth = Math.max(maxDepth, entry.depth);
        }
      }
    });

    return {
      totalFunctions: this.callGraph.nodes.length,
      reachableFunctions: reachableCount,
      unreachableFunctions: this.callGraph.nodes.length - reachableCount,
      averageDepth: reachableCount > 0 ? totalDepth / reachableCount : 0,
      maxDepth
    };
  }
}
