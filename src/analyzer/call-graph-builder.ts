/**
 * Call Graph Builder for WASM modules
 * Builds a static call graph showing function-to-function call relationships
 */

export interface CallGraphNode {
  index: number;
  name: string;
  type: 'local' | 'imported' | 'exported';
  exportNames?: string[];
  importModule?: string;
  importName?: string;
  outgoingCalls: number[];
  incomingCalls: number[];
  indirectCalls: number;
  unresolvedCalls: number;
}

export interface CallGraphEdge {
  from: number;
  to: number;
  callType: 'direct' | 'indirect' | 'unresolved';
  count: number;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  statistics: {
    totalFunctions: number;
    totalResolvedEdges: number;
    totalUnresolvedReferences: number;
    maxOutgoingCalls: { functionIndex: number; count: number };
    maxIncomingCalls: { functionIndex: number; count: number };
    functionsWithNoIncoming: number[];
    functionsWithNoOutgoing: number[];
    recursiveFunctions: number[];
    maxDepth: number;
  };
}

export class CallGraphBuilder {
  private nodes: Map<number, CallGraphNode> = new Map();
  private edges: CallGraphEdge[] = [];
  private wasmModule: any;
  private importCount: number = 0;

  constructor(wasmModule: any) {
    this.wasmModule = wasmModule;
    this.initialize();
  }

  private initialize(): void {
    // Count imported functions
    if (this.wasmModule.imports) {
      this.importCount = this.wasmModule.imports.filter(
        (imp: any) => imp.kind === 'function'
      ).length;
    }

    // Initialize nodes for imported functions
    if (this.wasmModule.imports) {
      this.wasmModule.imports.forEach((imp: any, idx: number) => {
        if (imp.kind === 'function') {
          this.nodes.set(idx, {
            index: idx,
            name: `${imp.module}.${imp.name}`,
            type: 'imported',
            importModule: imp.module,
            importName: imp.name,
            outgoingCalls: [],
            incomingCalls: [],
            indirectCalls: 0,
            unresolvedCalls: 0
          });
        }
      });
    }

    // Initialize nodes for local functions
    if (this.wasmModule.functions) {
      this.wasmModule.functions.forEach((func: any, idx: number) => {
        const funcIndex = this.importCount + idx;
        const node: CallGraphNode = {
          index: funcIndex,
          name: func.name || `func_${funcIndex}`,
          type: 'local',
          outgoingCalls: [],
          incomingCalls: [],
          indirectCalls: 0,
          unresolvedCalls: 0
        };

        // Check if this function is exported
        if (this.wasmModule.exports) {
          const exports = this.wasmModule.exports
            .filter((exp: any) => exp.kind === 'function' && exp.index === funcIndex)
            .map((exp: any) => exp.name);
          
          if (exports.length > 0) {
            node.type = 'exported';
            node.exportNames = exports;
          }
        }

        this.nodes.set(funcIndex, node);
      });
    }
  }

  build(): CallGraph {
    this.analyzeCallRelationships();
    const statistics = this.calculateStatistics();

    return {
      nodes: Array.from(this.nodes.values()).sort((a, b) => a.index - b.index),
      edges: this.edges.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        return a.to - b.to;
      }),
      statistics
    };
  }

  private analyzeCallRelationships(): void {
    if (!this.wasmModule.functions) return;

    this.wasmModule.functions.forEach((func: any, idx: number) => {
      const funcIndex = this.importCount + idx;
      const calls = this.extractCalls(func);

      calls.direct.forEach((targetIndex: number) => {
        this.addEdge(funcIndex, targetIndex, 'direct');
      });

      calls.indirect.forEach(() => {
        const node = this.nodes.get(funcIndex);
        if (node) {
          node.indirectCalls++;
        }
      });

      calls.unresolved.forEach(() => {
        const node = this.nodes.get(funcIndex);
        if (node) {
          node.unresolvedCalls++;
        }
      });
    });
  }

  private extractCalls(func: any): {
    direct: number[];
    indirect: number[];
    unresolved: number[];
  } {
    const direct: number[] = [];
    const indirect: number[] = [];
    const unresolved: number[] = [];

    if (!func.body || !func.body.instructions) {
      return { direct, indirect, unresolved };
    }

    func.body.instructions.forEach((instr: any) => {
      if (instr.name === 'call' && typeof instr.index === 'number') {
        direct.push(instr.index);
      } else if (instr.name === 'call_indirect') {
        indirect.push(instr);
      } else if (
        instr.name === 'call' && 
        typeof instr.index !== 'number'
      ) {
        unresolved.push(instr);
      }
    });

    return { direct, indirect, unresolved };
  }

  private addEdge(from: number, to: number, callType: 'direct' | 'indirect' | 'unresolved'): void {
    // Update nodes
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);

    if (fromNode && toNode) {
      if (!fromNode.outgoingCalls.includes(to)) {
        fromNode.outgoingCalls.push(to);
      }
      if (!toNode.incomingCalls.includes(from)) {
        toNode.incomingCalls.push(from);
      }

      // Update or create edge
      const existingEdge = this.edges.find(e => e.from === from && e.to === to);
      if (existingEdge) {
        existingEdge.count++;
      } else {
        this.edges.push({ from, to, callType, count: 1 });
      }
    }
  }

  private calculateStatistics(): CallGraph['statistics'] {
    const nodes = Array.from(this.nodes.values());
    
    // Max outgoing calls
    let maxOutgoingCalls = { functionIndex: -1, count: 0 };
    nodes.forEach(node => {
      if (node.outgoingCalls.length > maxOutgoingCalls.count) {
        maxOutgoingCalls = {
          functionIndex: node.index,
          count: node.outgoingCalls.length
        };
      }
    });

    // Max incoming calls
    let maxIncomingCalls = { functionIndex: -1, count: 0 };
    nodes.forEach(node => {
      if (node.incomingCalls.length > maxIncomingCalls.count) {
        maxIncomingCalls = {
          functionIndex: node.index,
          count: node.incomingCalls.length
        };
      }
    });

    // Functions with no incoming/outgoing calls
    const functionsWithNoIncoming = nodes
      .filter(n => n.incomingCalls.length === 0 && n.type !== 'imported')
      .map(n => n.index)
      .sort((a, b) => a - b);

    const functionsWithNoOutgoing = nodes
      .filter(n => n.outgoingCalls.length === 0)
      .map(n => n.index)
      .sort((a, b) => a - b);

    // Detect recursive functions
    const recursiveFunctions = this.detectRecursion();

    // Calculate max depth
    const maxDepth = this.calculateMaxDepth();

    // Total unresolved references
    const totalUnresolvedReferences = nodes.reduce(
      (sum, node) => sum + node.unresolvedCalls + node.indirectCalls,
      0
    );

    return {
      totalFunctions: nodes.length,
      totalResolvedEdges: this.edges.filter(e => e.callType === 'direct').length,
      totalUnresolvedReferences,
      maxOutgoingCalls,
      maxIncomingCalls,
      functionsWithNoIncoming,
      functionsWithNoOutgoing,
      recursiveFunctions,
      maxDepth
    };
  }

  private detectRecursion(): number[] {
    const recursive: Set<number> = new Set();
    const visited: Set<number> = new Set();
    const recStack: Set<number> = new Set();

    const dfs = (nodeIndex: number): boolean => {
      visited.add(nodeIndex);
      recStack.add(nodeIndex);

      const node = this.nodes.get(nodeIndex);
      if (!node) return false;

      for (const targetIndex of node.outgoingCalls) {
        if (!visited.has(targetIndex)) {
          if (dfs(targetIndex)) {
            recursive.add(nodeIndex);
            return true;
          }
        } else if (recStack.has(targetIndex)) {
          recursive.add(nodeIndex);
          recursive.add(targetIndex);
          return true;
        }
      }

      recStack.delete(nodeIndex);
      return false;
    };

    this.nodes.forEach((_, index) => {
      if (!visited.has(index)) {
        dfs(index);
      }
    });

    return Array.from(recursive).sort((a, b) => a - b);
  }

  private calculateMaxDepth(): number {
    let maxDepth = 0;

    const calculateDepth = (nodeIndex: number, visited: Set<number>): number => {
      if (visited.has(nodeIndex)) return 0; // Avoid cycles
      
      const node = this.nodes.get(nodeIndex);
      if (!node || node.outgoingCalls.length === 0) return 1;

      visited.add(nodeIndex);
      let maxChildDepth = 0;

      for (const targetIndex of node.outgoingCalls) {
        const depth = calculateDepth(targetIndex, new Set(visited));
        maxChildDepth = Math.max(maxChildDepth, depth);
      }

      return maxChildDepth + 1;
    };

    this.nodes.forEach((_, index) => {
      const depth = calculateDepth(index, new Set());
      maxDepth = Math.max(maxDepth, depth);
    });

    return maxDepth;
  }
}
