import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import WebSocket from "ws";

import * as schema from "./schema";

neonConfig.webSocketConstructor = WebSocket;

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
