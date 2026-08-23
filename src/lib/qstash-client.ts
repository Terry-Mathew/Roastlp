import { z } from "zod";

const publishResponseSchema = z.object({
  messageId: z.string().min(1).max(128),
});

export interface PublishOptions {
  destinationUrl: string;
  body: unknown;
  retries?: number;
  failureCallbackUrl?: string;
}

export class QStashPublishError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QStashPublishError";
  }
}

export class QStashClient {
  constructor(
    private token: string,
    private baseUrl = "https://qstash.upstash.io",
  ) {}

  async publish(options: PublishOptions): Promise<{ messageId: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "upstash-retries": String(options.retries ?? 3),
    };
    if (options.failureCallbackUrl)
      headers["upstash-failure-callback"] = options.failureCallbackUrl;

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v2/publish/${options.destinationUrl}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(options.body),
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (error) {
      throw new QStashPublishError("QStash publish request failed", {
        cause: error,
      });
    }

    if (!response.ok)
      throw new QStashPublishError(
        `QStash publish rejected (${response.status})`,
      );

    const parsed = publishResponseSchema.parse(await response.json());
    return { messageId: parsed.messageId };
  }
}
