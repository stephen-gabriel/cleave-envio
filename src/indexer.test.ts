import { describe, it } from "vitest";
import { createTestIndexer, type MockStock_Transfer } from "envio";
import { TestHelpers } from "envio";

describe("MockStock contract Transfer event tests", () => {
  it("MockStock_Transfer is created correctly", async (t) => {
    const indexer = createTestIndexer();

    // Creating mock for MockStock contract Transfer event
    const event = {
      contract: "MockStock" as const,
      event: "Transfer" as const,
      params: {
        from: TestHelpers.Addresses.defaultAddress,
        to: TestHelpers.Addresses.defaultAddress,
        value: 0n,
      },
    };

    await indexer.process({
      chains: {
        10143: {
          simulate: [event],
        },
      },
    });

    // Getting the actual entity from the test indexer
    let actualMockStockTransfer = await indexer.MockStock_Transfer.getOrThrow("10143_0_0");

    // Creating the expected entity
    const expectedMockStockTransfer = {
      id: "10143_0_0",
      from: event.params.from,
      to: event.params.to,
      value: event.params.value,
      chainId: 10143,
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    t.expect(actualMockStockTransfer, "Actual MockStockTransfer should be the same as the expected MockStockTransfer").toEqual(expectedMockStockTransfer);
  });
});

describe("Indexer smoke test", () => {
  it("processes the first block with events on chain 10143", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process({ chains: { 10143: {} } });

    t.expect(result.changes.length, "Should have at least one change").toBeGreaterThan(0);
    const firstChange = result.changes[0]!;
    t.expect(firstChange.chainId).toBe(10143);
    t.expect(firstChange.eventsProcessed).toBeGreaterThan(0);
  }, 60_000);
});
