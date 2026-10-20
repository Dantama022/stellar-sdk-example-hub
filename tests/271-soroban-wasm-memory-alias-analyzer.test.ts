import { analyzeSorobanWasmMemoryAliasing, runExample } from "../src/examples/271-soroban-wasm-memory-alias-analyzer";

describe("271-soroban-wasm-memory-alias-analyzer", () => {
  it("evaluates healthy WASM metrics within nominal thresholds", () => {
    const res = analyzeSorobanWasmMemoryAliasing({
      subjectId: "wasm-contract-001",
      overlappingRegionCount: 5,
      unalignedStoreCount: 3,
      linearMemoryPages: 10,
      thresholdLimit: 100,
    });
    expect(res.status).toBe("healthy");
    expect(res.inspectorPublicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("flags critical status when metrics breach thresholdLimit", () => {
    const res = analyzeSorobanWasmMemoryAliasing({
      subjectId: "wasm-contract-002",
      overlappingRegionCount: 120,
      unalignedStoreCount: 80,
      linearMemoryPages: 250,
      thresholdLimit: 100,
    });
    expect(res.status).toBe("critical");
  });

  it("executes runExample cleanly", async () => {
    await expect(runExample()).resolves.toBeUndefined();
  });
});
