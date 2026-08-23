import { afterEach, describe, expect, it, vi } from "vitest";

import { QStashClient, QStashPublishError } from "./qstash-client";

afterEach(() => vi.unstubAllGlobals());

describe("POR-17 QStash publish client", () => {
  it("publishes with bearer auth, retry budget and failure callback", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: "msg_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new QStashClient("qstash-token").publish({
      destinationUrl: "https://app.example/api/audit-jobs/run",
      body: { jobId: "job-1" },
      retries: 3,
      failureCallbackUrl: "https://app.example/api/audit-jobs/failed",
    });

    expect(result.messageId).toBe("msg_123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://qstash.upstash.io/v2/publish/https://app.example/api/audit-jobs/run",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer qstash-token");
    expect(headers["upstash-retries"]).toBe("3");
    expect(headers["upstash-failure-callback"]).toBe(
      "https://app.example/api/audit-jobs/failed",
    );
    expect(JSON.parse(String(init.body))).toEqual({ jobId: "job-1" });
  });

  it("maps provider rejections to a publish error without leaking bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"secret":"x"}', { status: 403 })),
    );
    await expect(
      new QStashClient("token").publish({
        destinationUrl: "https://app.example/w",
        body: {},
      }),
    ).rejects.toThrow("QStash publish rejected (403)");
    await expect(new QStashPublishError("boom")).toBeInstanceOf(Error);
  });

  it("rejects malformed provider responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      ),
    );
    await expect(
      new QStashClient("token").publish({
        destinationUrl: "https://app.example/w",
        body: {},
      }),
    ).rejects.toThrow();
  });
});
