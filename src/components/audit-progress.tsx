"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const FAST_INTERVAL_MS = 5_000;
const SLOW_INTERVAL_MS = 15_000;
const SLOW_AFTER_POLLS = 6;
const MAX_POLL_MINUTES = 15;

const PROCESSING_LINES = [
  "Capturing a full-page screenshot of your landing page…",
  "The AI is judging your hero section…",
  "Checking whether your offer is clear above the fold…",
  "Weighing your call-to-action against every distraction…",
  "Looking for trust signals — or the lack of them…",
  "Scoring friction, hierarchy, and copy clarity…",
] as const;

type Phase = "working" | "ready" | "failed" | "lost-key" | "stalled";

/**
 * POR-21: truthful progress. No fake timers, no fake human review. Polling
 * starts at 5s and backs off to 15s; it stops on terminal states. Refreshing
 * never restarts an audit.
 */
export function AuditProgress({ roastId }: { roastId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("working");
  const [lineIndex, setLineIndex] = useState(0);
  const viewKeyRef = useRef<string | null>(null);

  // The payer's browser received this once at checkout time.
  useEffect(() => {
    try {
      viewKeyRef.current = sessionStorage.getItem(`rm-view:${roastId}`);
    } catch {
      viewKeyRef.current = null;
    }
    if (!viewKeyRef.current) setPhase("lost-key");
  }, [roastId]);

  useEffect(() => {
    if (phase === "lost-key") return;
    const startedAt = Date.now();
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const response = await fetch(`/api/audits/${roastId}/status`, {
          method: "POST",
          cache: "no-store",
        });
        if (response.ok) {
          const { state } = (await response.json()) as { state: string };
          if (state === "completed") {
            setPhase("ready");
            router.replace(
              viewKeyRef.current
                ? `/r/${viewKeyRef.current}`
                : `/auditing/${roastId}`,
            );
            return;
          }
          if (state === "failed") {
            setPhase("failed");
            return;
          }
        }
      } catch {
        // Transient network issues: keep polling quietly.
      }

      polls += 1;
      if ((Date.now() - startedAt) / 60_000 >= MAX_POLL_MINUTES) {
        setPhase("stalled");
        return;
      }
      timer = setTimeout(
        poll,
        polls > SLOW_AFTER_POLLS ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS,
      );
    }

    timer = setTimeout(poll, FAST_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [phase, roastId, router]);

  useEffect(() => {
    if (phase !== "working") return;
    const rotate = setInterval(
      () => setLineIndex((current) => current + 1),
      4_000,
    );
    return () => clearInterval(rotate);
  }, [phase]);

  return (
    <section className="page-shell grid min-h-[70vh] place-items-center py-16">
      <div className="w-full max-w-2xl text-center">
        {phase !== "failed" ? (
          <>
            <p className="eyebrow">Working</p>
            <p
              aria-live="polite"
              role="status"
              className="mt-4 text-2xl leading-snug font-black tracking-[-0.02em] text-balance sm:text-3xl"
            >
              {phase === "stalled"
                ? "This is taking longer than expected."
                : phase === "lost-key"
                  ? "Your report will be delivered to the email you provided."
                  : PROCESSING_LINES[lineIndex % PROCESSING_LINES.length]}
            </p>
            <p className="text-muted mt-5 text-sm leading-6">
              {phase === "stalled"
                ? "Leave this tab open — you will also receive the private report link by email when it completes."
                : phase === "lost-key"
                  ? "Keep this page open if you like; the private link arrives by email either way."
                  : "This usually takes under two minutes. You can safely leave this tab open — the private link is also sent to your email."}
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">Audit failed</p>
            <h1 className="mt-4 text-2xl font-black tracking-[-0.02em] text-balance sm:text-3xl">
              We could not complete your review.
            </h1>
            <p className="text-muted mx-auto mt-5 max-w-xl text-sm leading-6">
              A technical failure occurred after your payment. Your purchase
              qualifies for a refund under our refund policy — no action is
              needed from you. Nothing about your landing page was wrong.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
