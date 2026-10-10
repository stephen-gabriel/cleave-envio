/*
 * Please refer to https://docs.envio.dev for a thorough guide on all Envio indexer features
 */
import { indexer } from "envio";
import type {
  MockStock_Transfer,
} from "envio";

indexer.onEvent({ contract: "MockStock", event: "Transfer" }, async ({ event, context }) => {
  const entity: MockStock_Transfer = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    from: event.params.from,
    to: event.params.to,
    value: event.params.value,
  };

  context.MockStock_Transfer.set(entity);
});
