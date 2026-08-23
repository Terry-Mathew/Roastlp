import type { StoredRoastReport } from "../lib/roast-schema";

const SECTIONS = [
  { key: "explanation", label: "What is happening" },
  { key: "evidence", label: "What we can see" },
  { key: "conversionImpact", label: "What it costs you" },
] as const;

function verdictTone(verdict: string): string {
  switch (verdict) {
    case "Brutal":
    case "Rough":
      return "text-signal";
    case "Fixable":
      return "text-paper";
    default:
      return "text-muted";
  }
}

/**
 * POR-23: the paid deliverable. Every model-generated string renders as plain
 * React text (auto-escaped); no dangerouslySetInnerHTML anywhere. Score
 * meaning is carried by the verdict text, never by color alone.
 */
export interface ReportViewData {
  hostname: string;
  report: unknown;
  model: string;
  /** Signed, short-lived scorecard image path; absent when HMAC key unset. */
  scorecardPath?: string;
}

export function ReportView({
  hostname,
  report,
  model,
  scorecardPath,
}: ReportViewData) {
  const parsed = report as StoredRoastReport;
  // Customer-editable prefill; the link goes to the public homepage, never
  // to this private report or its capability URL.
  const shareText = encodeURIComponent(
    `My landing page scored ${parsed.score}/100 — verdict: ${parsed.verdict}. Brutal, honest CRO feedback in about a minute.`,
  );
  const shareUrl = encodeURIComponent("https://roastmylp.in");
  const shareIntent = `https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}`;

  return (
    <article className="page-shell py-10 sm:py-14">
      <p className="eyebrow">Roast complete</p>
      <h1 className="mt-3 font-mono text-lg font-bold tracking-[0.02em] break-all sm:text-xl">
        {hostname}
      </h1>

      <div className="border-rule mt-8 grid items-center gap-6 border p-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:p-8">
        <p className="text-signal text-7xl leading-none font-black tracking-[-0.04em] tabular-nums sm:text-8xl">
          {parsed.score}
          <span className="text-muted align-top text-3xl">/100</span>
        </p>
        <div>
          <p className="font-mono text-xs tracking-[0.14em] uppercase">
            CRO score · automated review
          </p>
          <p
            className={`mt-2 text-3xl font-black tracking-[-0.03em] uppercase ${verdictTone(parsed.verdict)}`}
          >
            Verdict: {parsed.verdict}
          </p>
          <p className="text-muted mt-2 max-w-prose text-sm leading-6">
            0–39 Brutal · 40–59 Rough · 60–74 Fixable · 75–89 Solid · 90–100
            Sharp. This is an automated opinion on a screenshot, not a guarantee
            of conversion results.
          </p>
        </div>
      </div>

      <section aria-labelledby="critiques-heading" className="mt-12">
        <h2
          id="critiques-heading"
          className="border-rule border-b pb-3 font-mono text-sm tracking-[0.14em] uppercase"
        >
          Five things costing you conversions
        </h2>
        <ol className="mt-6 space-y-6">
          {parsed.critiques.map((critique, index) => (
            <li
              key={critique.headline}
              className="border-rule bg-panel border p-5 sm:p-6"
            >
              <p className="text-signal font-mono text-xs font-black tracking-[0.14em]">
                {String(index + 1).padStart(2, "0")}
              </p>
              <h3 className="mt-2 text-xl leading-snug font-black tracking-[-0.02em] sm:text-2xl">
                {critique.headline}
              </h3>
              <dl className="text-muted mt-4 space-y-3 text-sm leading-6">
                {SECTIONS.map(({ key, label }) => (
                  <div key={key}>
                    <dt className="font-mono text-[0.65rem] tracking-[0.14em] uppercase">
                      {label}
                    </dt>
                    <dd className="text-paper/90 mt-1">
                      {critique[key as keyof typeof critique]}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="positive-heading" className="mt-12">
        <h2
          id="positive-heading"
          className="border-rule border-b pb-3 font-mono text-sm tracking-[0.14em] uppercase"
        >
          One thing worth keeping
        </h2>
        <div className="border-signal bg-panel mt-6 border-l-2 p-5 sm:p-6">
          <h3 className="text-xl font-black tracking-[-0.02em] sm:text-2xl">
            {parsed.positiveObservation.headline}
          </h3>
          <p className="text-muted mt-2 text-sm leading-6">
            {parsed.positiveObservation.explanation}
          </p>
        </div>
      </section>

      {scorecardPath ? (
        <section
          aria-labelledby="share-heading"
          className="border-rule bg-panel mt-12 border p-5 sm:p-6"
        >
          <h2
            id="share-heading"
            className="font-mono text-sm tracking-[0.14em] uppercase"
          >
            Show off the damage
          </h2>
          <p className="text-muted mt-2 max-w-prose text-sm leading-6">
            The scorecard image contains only your domain, score, and verdict —
            never this private link. Sharing opens X with editable copy.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <a
              href={scorecardPath}
              download={`roastmylp-${hostname}-scorecard.png`}
              className="cta focus-ring min-h-12 px-5 py-3 text-center font-mono text-sm font-black tracking-[0.06em] uppercase"
            >
              Download scorecard PNG
            </a>
            <a
              href={shareIntent}
              target="_blank"
              rel="noreferrer noopener"
              className="focus-ring border-rule min-h-12 border px-5 py-3 text-center font-mono text-sm font-bold tracking-[0.06em] uppercase hover:border-[var(--signal)]"
            >
              Share on X
            </a>
          </div>
        </section>
      ) : null}

      <p className="text-muted mt-12 font-mono text-[0.65rem] tracking-[0.12em] uppercase">
        Automated analysis · model {model} · this link is private and revocable
      </p>
    </article>
  );
}
