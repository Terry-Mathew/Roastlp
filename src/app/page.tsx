import Link from "next/link";
import { RoastIntakeForm } from "@/components/roast-intake-form";
import { PRODUCT_NAME, ROAST_PRICE_INR } from "@/lib/product";

const deliverables = [
  "A conversion score out of 100",
  "Five problems grounded in the visible page",
  "One thing your page already gets right",
  "A private report and shareable scorecard",
];

const process = [
  ["Capture", "We take a full-page screenshot of the public URL you submit."],
  [
    "Inspect",
    "AI reviews clarity, hierarchy, trust, friction, and conversion intent.",
  ],
  [
    "Deliver",
    "You receive a private score, five critiques, and one positive observation.",
  ],
] as const;

export default function Home() {
  return (
    <main className="bg-ink text-paper min-h-screen overflow-hidden">
      <header className="border-rule border-b">
        <div className="page-shell flex min-h-14 items-center justify-between gap-4 py-3 font-mono text-[0.68rem] tracking-[0.16em] uppercase sm:text-xs">
          <Link href="/" className="focus-ring text-paper font-bold">
            {PRODUCT_NAME}
          </Link>
          <p className="text-muted text-right">
            Screenshot CRO review <span aria-hidden="true">/</span>{" "}
            <span className="text-signal">₹{ROAST_PRICE_INR}</span>
          </p>
        </div>
      </header>

      <section className="page-shell grid gap-10 py-12 lg:grid-cols-[minmax(0,1.35fr)_minmax(21rem,0.65fr)] lg:gap-16 lg:py-20">
        <div className="min-w-0">
          <p className="eyebrow">Your landing page, under pressure</p>
          <h1 className="mt-5 max-w-4xl text-[clamp(2.75rem,8vw,7.25rem)] leading-[0.89] font-black tracking-[-0.065em] text-balance uppercase">
            Find what&apos;s costing you conversions.
          </h1>
          <p className="text-muted mt-7 max-w-2xl text-base leading-7 sm:text-lg sm:leading-8">
            Send us your landing page. Our AI reviews a full-page screenshot,
            scores it out of 100, and gives you five specific conversion
            problems to fix.
          </p>
          <div className="border-rule mt-9 grid grid-cols-2 border font-mono text-[0.68rem] tracking-[0.12em] uppercase sm:grid-cols-4 sm:text-xs">
            {[
              "No account",
              "Private report",
              "Emailed to you",
              "Automated analysis",
            ].map((item, index) => (
              <span
                key={item}
                className={`border-rule text-muted px-3 py-3 text-center ${index % 2 === 0 ? "border-r" : ""} ${index >= 2 ? "border-t" : ""} sm:border-t-0 sm:not-last:border-r`}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <RoastIntakeForm />
      </section>

      <section
        className="border-rule bg-panel border-y"
        aria-labelledby="get-heading"
      >
        <div className="page-shell grid lg:grid-cols-[0.62fr_1.38fr]">
          <div className="border-rule relative overflow-hidden py-10 lg:border-r lg:py-14">
            <p className="eyebrow">Report format</p>
            <h2
              id="get-heading"
              className="mt-4 text-4xl font-black tracking-[-0.045em] uppercase sm:text-5xl"
            >
              What you get
            </h2>
            <span
              aria-hidden="true"
              className="text-rule/50 pointer-events-none absolute -right-2 -bottom-12 hidden font-mono text-[10rem] leading-none font-black sm:block"
            >
              100
            </span>
          </div>
          <ol>
            {deliverables.map((item, index) => (
              <li
                key={item}
                className="border-rule grid grid-cols-[2.75rem_1fr] gap-3 py-5 not-last:border-b sm:grid-cols-[4rem_1fr] sm:py-6"
              >
                <span className="text-signal font-mono text-sm">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-lg font-semibold sm:text-xl">{item}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className="page-shell py-14 sm:py-20"
        aria-labelledby="process-heading"
      >
        <div className="border-rule flex flex-col justify-between gap-4 border-b pb-6 sm:flex-row sm:items-end">
          <div>
            <p className="eyebrow">The review</p>
            <h2
              id="process-heading"
              className="mt-3 text-4xl font-black tracking-[-0.045em] uppercase sm:text-5xl"
            >
              Three steps. No theatre.
            </h2>
          </div>
          <p className="text-muted max-w-sm text-sm leading-6">
            An automated CRO opinion—not a promise of improved sales, a security
            audit, or a substitute for user research.
          </p>
        </div>
        <ol className="border-rule grid sm:grid-cols-3 sm:border-x">
          {process.map(([title, detail], index) => (
            <li
              key={title}
              className="border-rule min-w-0 py-7 max-sm:not-last:border-b sm:px-6 sm:not-last:border-r"
            >
              <p className="text-signal font-mono text-xs tracking-[0.16em] uppercase">
                {String(index + 1).padStart(2, "0")} / {title}
              </p>
              <p className="text-muted mt-4 leading-7">{detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="border-rule bg-paper text-ink border-t"
        aria-labelledby="privacy-heading"
      >
        <div className="page-shell grid gap-8 py-12 lg:grid-cols-[0.8fr_1.2fr] lg:py-16">
          <div>
            <p className="text-red font-mono text-xs font-bold tracking-[0.16em] uppercase">
              Private by default
            </p>
            <h2
              id="privacy-heading"
              className="mt-4 text-4xl font-black tracking-[-0.045em] uppercase sm:text-5xl"
            >
              Reviewed. Not published.
            </h2>
          </div>
          <div className="text-stone grid gap-6 text-base leading-7 sm:grid-cols-2">
            <p>
              Your full report is delivered through a private link. We never
              publish customer audits or use them as examples without recorded
              permission.
            </p>
            <p>
              We use your email for this purchase and its service messages—not
              to quietly add you to a marketing list. Sharing the sanitized
              scorecard is always your choice.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-rule bg-ink border-t">
        <div className="page-shell text-muted flex flex-col gap-5 py-7 font-mono text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>© {PRODUCT_NAME}</p>
          <nav
            aria-label="Legal information"
            className="flex flex-wrap gap-x-5 gap-y-3"
          >
            <Link className="footer-link" href="#privacy-heading">
              Privacy
            </Link>
            <Link className="footer-link" href="#service-terms">
              Service terms
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
