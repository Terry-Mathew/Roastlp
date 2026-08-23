import {
  DrizzleEmailRepository,
  buildEmailIdempotencyKey,
  hashEmailIdempotencyKey,
} from "../db/email-repository";
import type { Database } from "../db/client";
import { productEvents } from "../db/schema";
import {
  ResendRejectedError,
  ResendUnavailableError,
  type ResendApiClient,
} from "./resend-client";

export interface EmailSenderOptions {
  fromEmail: string;
  appUrl: string;
  serviceName?: string;
  serviceContact: string;
  /** Injectable for tests; defaults to structured stderr, PII-free. */
  log?: (payload: Record<string, unknown>) => void;
}

export interface SendOutcome {
  status:
    | "sent"
    | "already_sent"
    | "pending_retry"
    | "failed_terminal"
    | "skipped_state";
}

/** Roast states at which transactional email is meaningful. */
const DELIVERABLE_STATES = new Set([
  "completed",
  "terminal_failure",
  "refunded",
]);

function defaultLog(payload: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: "EMAIL_DELIVERY", ...payload }));
}

/**
 * POR-25 transactional email sender.
 *
 * Idempotency is layered twice: a deterministic provider Idempotency-Key per
 * (roast, kind) plus the durable email_deliveries ledger whose unique hash
 * collapses concurrent sends onto one row. Retries therefore cannot duplicate
 * excessively — at worst one extra send races before the ledger row exists.
 *
 * Redaction rule (acceptance criteria): recipient addresses, view keys and
 * rendered report content never appear in logs or persisted error codes.
 */
export class EmailSender {
  private repository: DrizzleEmailRepository;

  constructor(
    private db: Database,
    private api: ResendApiClient,
    private options: EmailSenderOptions,
  ) {
    this.repository = new DrizzleEmailRepository(db);
  }

  async sendResultEmail(input: {
    roastId: string;
    /** Raw view-key capability; rendered only into the email body. */
    viewKey: string;
  }): Promise<SendOutcome> {
    const reportUrl = `${this.appUrl()}/r/${input.viewKey}`;
    return this.send({
      roastId: input.roastId,
      kind: "result",
      subject: `Your Roast is ready (${this.serviceName()})`,
      text: [
        "Your Roast is ready.",
        "",
        `Private report (do not share this link): ${reportUrl}`,
        "",
        "This link is the only way to access your report - keep it safe.",
        `Questions? ${this.options.serviceContact}`,
        "",
        `- The ${this.serviceName()} team`,
      ].join("\n"),
      html: [
        "<p>Your Roast is ready.</p>",
        `<p><a href="${reportUrl}">Open your private report</a></p>`,
        "<p><em>This link is the only way to access your report - do not share it.</em></p>",
        `<p>Questions? ${this.options.serviceContact}</p>`,
        `<p>- The ${this.serviceName()} team</p>`,
      ].join(""),
      recordEvent: true,
    });
  }

  /**
   * Processing failure without a settled refund yet: the audit failed and a
   * refund has been initiated. Deliberately does not claim money is back.
   */
  async sendProcessingFailureEmail(input: { roastId: string }) {
    return this.send({
      roastId: input.roastId,
      kind: "processing_failure",
      subject: `Your Roast could not be completed (${this.serviceName()})`,
      text: [
        "Unfortunately your audit could not be completed.",
        "",
        "A full refund of your payment has been initiated with our payment",
        "provider. Bank settlement usually takes 5-7 business days.",
        "A second email will confirm once the refund is complete.",
        "",
        `Questions? ${this.options.serviceContact}`,
        "",
        `- The ${this.serviceName()} team`,
      ].join("\n"),
      html: [
        "<p>Unfortunately your audit could not be completed.</p>",
        "<p>A <strong>full refund has been initiated</strong> with our payment provider. Bank settlement usually takes 5-7 business days.</p>",
        "<p>A second email will confirm once the refund is complete.</p>",
        `<p>Questions? ${this.options.serviceContact}</p>`,
        `<p>- The ${this.serviceName()} team</p>`,
      ].join(""),
    });
  }

  /** Confirmed refund completion - distinct from the initiation notice. */
  async sendRefundCompletedEmail(input: { roastId: string }) {
    return this.send({
      roastId: input.roastId,
      kind: "refund_completed",
      subject: `Your refund is complete (${this.serviceName()})`,
      text: [
        "Your refund is complete.",
        "",
        "The full amount you paid has been returned to your original payment",
        "method by our payment provider. No further action is needed.",
        "",
        `Questions? ${this.options.serviceContact}`,
        "",
        `- The ${this.serviceName()} team`,
      ].join("\n"),
      html: [
        "<p>Your refund is complete.</p>",
        "<p>The full amount you paid has been returned to your original payment method. No further action is needed.</p>",
        `<p>Questions? ${this.options.serviceContact}</p>`,
        `<p>- The ${this.serviceName()} team</p>`,
      ].join(""),
    });
  }

  private async send(input: {
    roastId: string;
    kind: "result" | "processing_failure" | "refund_completed";
    subject: string;
    text: string;
    html: string;
    recordEvent?: boolean;
  }): Promise<SendOutcome> {
    const context = await this.repository.deliveryContextFor(input.roastId);
    if (!context || !DELIVERABLE_STATES.has(context.state)) {
      // Never email mid-flight roasts; the recovery sweep re-checks later.
      return { status: "skipped_state" };
    }

    const rawKey = buildEmailIdempotencyKey(input.kind, input.roastId);
    const { record, created } = await this.repository.ensurePending({
      roastId: input.roastId,
      kind: input.kind,
      idempotencyKeyHash: hashEmailIdempotencyKey(rawKey),
    });
    void created;
    if (record.state === "sent") return { status: "already_sent" };
    if (record.state === "bounced" || record.state === "complained")
      return { status: "failed_terminal" };

    try {
      const result = await this.api.send({
        from: this.options.fromEmail,
        to: context.recipient,
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: { "idempotency-key": rawKey },
      });
      await this.repository.markSent(record.id, result.id);
      if (input.recordEvent) await this.recordResultEvent(input.roastId);
      this.log({ outcome: "sent", kind: input.kind });
      return { status: "sent" };
    } catch (error) {
      if (error instanceof ResendRejectedError) {
        await this.repository.markFailed(record.id, error.errorCode);
        this.log({
          outcome: "rejected",
          kind: input.kind,
          code: error.errorCode,
        });
        return { status: "failed_terminal" };
      }
      if (error instanceof ResendUnavailableError) {
        // Ledger row stays pending so the recovery sweep retries safely.
        this.log({ outcome: "retry_scheduled", kind: input.kind });
        return { status: "pending_retry" };
      }
      throw error;
    }
  }

  private async recordResultEvent(roastId: string): Promise<void> {
    await this.db
      .insert(productEvents)
      .values({ roastId, name: "result_email_sent", correlationId: roastId })
      .onConflictDoNothing();
  }

  private appUrl(): string {
    return this.options.appUrl.replace(/\/+$/, "");
  }

  private serviceName(): string {
    return this.options.serviceName ?? "RoastMyLP";
  }

  private log(payload: Record<string, unknown>): void {
    (this.options.log ?? defaultLog)(payload);
  }
}
