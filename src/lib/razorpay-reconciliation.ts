import { z } from "zod";

const paymentSchema = z
  .object({
    id: z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .max(64),
    entity: z.literal("payment"),
    amount: z.number().int().positive(),
    amount_captured: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
    order_id: z
      .string()
      .regex(/^order_[A-Za-z0-9]+$/)
      .max(64),
    captured: z.boolean(),
  })
  .passthrough();

const orderSchema = z
  .object({
    id: z
      .string()
      .regex(/^order_[A-Za-z0-9]+$/)
      .max(64),
    entity: z.literal("order"),
    amount: z.number().int().positive(),
    amount_paid: z.number().int().nonnegative(),
    amount_due: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    receipt: z.string().min(1).max(40),
    status: z.enum(["created", "attempted", "paid"]),
  })
  .passthrough();

export type ReconciledPayment = z.infer<typeof paymentSchema>;
export type ReconciledOrder = z.infer<typeof orderSchema>;

export interface RazorpayReconciliationProvider {
  fetchPayment(paymentId: string): Promise<ReconciledPayment>;
  fetchOrder(orderId: string): Promise<ReconciledOrder>;
}

export class RazorpayReconciliationApi implements RazorpayReconciliationProvider {
  constructor(
    private keyId: string,
    private keySecret: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async get(
    path: string,
    schema: typeof paymentSchema | typeof orderSchema,
  ) {
    const response = await this.fetcher(`https://api.razorpay.com/v1/${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(
        `Razorpay reconciliation request failed (${response.status})`,
      );
    if (
      response.headers.get("content-type")?.split(";", 1)[0] !==
      "application/json"
    )
      throw new Error("Razorpay reconciliation returned a non-JSON response");
    const text = await response.text();
    if (Buffer.byteLength(text) > 65_536)
      throw new Error("Razorpay reconciliation response was too large");
    return schema.parse(JSON.parse(text));
  }

  async fetchPayment(paymentId: string) {
    return paymentSchema.parse(
      await this.get(`payments/${paymentId}`, paymentSchema),
    );
  }

  async fetchOrder(orderId: string) {
    return orderSchema.parse(await this.get(`orders/${orderId}`, orderSchema));
  }
}
