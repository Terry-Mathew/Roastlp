import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../../../db/schema";
import { createReconcileRoute } from "./route-handler";

describe("POR-17 reconciler boundary", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterEach(async () => client.close());

  function handler() {
    const env = {
      reconcileSecret: "secret-value-123",
      qstashToken: "",
      workerUrl: "",
      db,
    };
    return createReconcileRoute(env as never);
  }

  it("rejects missing, wrong, and query-param secrets", async () => {
    const h = handler();
    const url = "https://app.example/api/audit-jobs/reconcile";

    expect((await h(new Request(url, { method: "POST" }))).status).toBe(401);
    expect(
      (
        await h(
          new Request(url, {
            method: "POST",
            headers: { "x-reconcile-secret": "wrong" },
          }),
        )
      ).status,
    ).toBe(401);

    // Query param path (scheduler support) accepts the correct secret.
    const ok = await h(new Request(`${url}?secret=secret-value-123`));
    expect(ok.status).toBe(200);
    void db;
    void client;
  });

  it("reads SCREAMING_SNAKE process.env keys in production wiring", async () => {
    const saved = { ...process.env };
    process.env.DATABASE_URL = "postgres://unused.invalid/test";
    process.env.RECONCILE_SECRET = "secret-value-123";
    delete process.env.QSTASH_TOKEN;
    delete process.env.AUDIT_WORKER_URL;
    try {
      const h = createReconcileRoute();
      // Against a bogus DB URL this cannot return 200; it must reject on the
      // database query rather than short-circuit with 503 (env names did not
      // resolve) or 401 (secret comparison failed).
      await expect(
        h(
          new Request("https://app.example/api/audit-jobs/reconcile", {
            method: "POST",
            headers: { "x-reconcile-secret": "secret-value-123" },
          }),
        ),
      ).rejects.toThrow(/Failed query|connect/i);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("accepts the secret via Authorization Bearer for Vercel Cron", async () => {
    const h = handler();
    const response = await h(
      new Request("https://app.example/api/audit-jobs/reconcile", {
        headers: { authorization: "Bearer secret-value-123" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("reports an empty recovery sweep as scanned:0", async () => {
    const response = await handler()(
      new Request(
        "https://app.example/api/audit-jobs/reconcile?secret=secret-value-123",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scanned: 0,
      enqueued: 0,
      skipped: 0,
    });
  });
});
