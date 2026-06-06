// Temporal Client seam for the Next app (server actions). Constructs a single cached
// Client from the connection seam + encryption codec. The client uses a pure gRPC
// connection (no native addon), so it is safe to import from a server action.

import "server-only";
import { Client, Connection } from "@temporalio/client";
import { getDataConverter } from "./codec";
import { getTemporalEnv } from "./connection";

let cached: Client | undefined;

export async function getTemporalClient(): Promise<Client> {
  if (cached) return cached;
  const { address, namespace, tls } = getTemporalEnv();
  const connection = await Connection.connect({ address, tls });
  cached = new Client({ connection, namespace, dataConverter: getDataConverter() });
  return cached;
}
