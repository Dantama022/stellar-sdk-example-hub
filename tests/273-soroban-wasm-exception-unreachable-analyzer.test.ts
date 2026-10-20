import { analyzeSorobanWasmExceptionPaths, runExample } from "../src/examples/273-soroban-wasm-exception-unreachable-analyzer";

describe("273-soroban-wasm-exception-unreachable-analyzer", () => {
  it("evaluates healthy WASM metrics within nominal thresholds", () => {
    const res = analyzeSorobanWasmExceptionPaths({
      subjectId: "wasm-contract-001",
      unreachableTrapCount: 5,
      panicBranchCount: 3,
      deadBlockBytes: 10,
      thresholdLimit: 100,
    });
    expect(res.status).toBe("healthy");
    expect(res.inspectorPublicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("flags critical status when metrics breach thresholdLimit", () => {
    const res = analyzeSorobanWasmExceptionPaths({
      subjectId: "wasm-contract-002",
      unreachableTrapCount: 120,
      panicBranchCount: 80,
      deadBlockBytes: 250,
      thresholdLimit: 100,
    });
    expect(res.status).toBe("critical");
  });

  it("executes runExample cleanly", async () => {
    await expect(runExample()).resolves.toBeUndefined();
  });
});
