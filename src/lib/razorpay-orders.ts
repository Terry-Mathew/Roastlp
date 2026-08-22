import { z } from "zod";
import { ROAST_AMOUNT_PAISE, ROAST_CURRENCY } from "./checkout-policy";

const orderSchema = z.object({
  id: z.string().regex(/^order_[A-Za-z0-9]+$/),
  entity: z.literal("order"),
  amount: z.literal(ROAST_AMOUNT_PAISE),
  amount_paid: z.literal(0),
  amount_due: z.literal(ROAST_AMOUNT_PAISE),
  currency: z.literal(ROAST_CURRENCY),
  receipt: z.string().max(40),
  status: z.literal("created"),
});

export type RazorpayOrder = z.infer<typeof orderSchema>;
export interface OrderProvider {
  create(receipt: string, roastId: string): Promise<RazorpayOrder>;
  findByReceipt(receipt: string): Promise<RazorpayOrder | undefined>;
}

export class RazorpayOrders implements OrderProvider {
  constructor(
    private keyId: string,
    private keySecret: string,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`https://api.razorpay.com${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Razorpay order request failed (${response.status})`);
    return response.json();
  }

  async create(receipt: string, roastId: string) {
    const raw = await this.request("/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: ROAST_AMOUNT_PAISE,
        currency: ROAST_CURRENCY,
        receipt,
        partial_payment: false,
        notes: { roast_ref: roastId },
      }),
    });
    const order = orderSchema.parse(raw);
    if (order.receipt !== receipt)
      throw new Error("Razorpay order receipt mismatch");
    return order;
  }

  async findByReceipt(receipt: string) {
    const raw = z
      .object({ items: z.array(orderSchema) })
      .parse(
        await this.request(`/v1/orders?receipt=${encodeURIComponent(receipt)}`),
      );
    if (raw.items.length > 1)
      throw new Error("Multiple Razorpay orders matched one receipt");
    const order = raw.items[0];
    if (order && order.receipt !== receipt)
      throw new Error("Razorpay receipt lookup mismatch");
    return order;
  }
}
