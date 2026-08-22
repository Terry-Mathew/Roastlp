# Environments, protected delivery and rollback

- Status: GitHub and Vercel delivery paths verified; credential isolation and rollback drill remain before POR-8 closes
- Runtime: Node.js 24 LTS, pnpm 11
- Linear: POR-8

## Environment contract

| Environment | Source                      | Data/providers                                                                  | Purpose                                 | Deployment rule                                                   |
| ----------- | --------------------------- | ------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Local       | Developer checkout          | Local/test credentials only; no production data                                 | Development and deterministic tests     | `.env.local` is ignored and created by the developer              |
| Preview     | Pull request                | Isolated preview database branch and provider test credentials                  | Review each change                      | Vercel Preview; never production Razorpay keys or real buyer data |
| Staging     | Persistent `staging` branch | Persistent staging DB and provider test modes, isolated from preview/production | Integration, webhook and go-live drills | Vercel Preview deployment after required GitHub checks pass       |
| Production  | Protected `main` branch     | Production DB/regions and live credentials                                      | Live ₹199 service                       | Vercel Production deployment after a checked pull request merges  |

`APP_ENV` is one of `local`, `preview`, `staging`, or `production`. `APP_URL` and `NEXT_PUBLIC_APP_URL` must name the same environment. Server startup validation will be added with provider integrations; a production process must refuse test keys and a non-production process must refuse live Razorpay keys.

`.env.example` is the canonical variable-name inventory and contains no values. Secrets live only in the relevant Vercel environment or local untracked file. Preview, staging and production must use separate database branches and provider credentials. As of 2026-08-23, the placeholder Vercel variables are scoped to both Production and Preview; do not connect live providers or process customer data until their values are replaced with environment-isolated credentials and the isolation is evidenced.

## Required checks and deployment protection

Configure the GitHub default branch as `main` after the repository's first commit, then enable a ruleset that:

- requires a pull request; while Terry is the only collaborator, required external approvals are zero so the repository is not deadlocked—raise this to one when a second reviewer is added;
- requires `Install, type-check, lint, test, audit and build`, `Secret scan`, and `Browser smoke test`;
- requires the branch to be current and conversations resolved;
- blocks force pushes and deletion; and
- applies to administrators unless an audited emergency bypass is used.

Vercel is connected to `Terry-Mathew/Roastlp`. It automatically creates Production deployments from `main` and protected Preview deployments from every other branch. On the Hobby plan, custom Vercel environments are unavailable, so `staging` is intentionally a persistent protected Preview branch rather than a Vercel custom environment. Keep live Razorpay credentials absent until every Linear `launch-blocker` is Done.

GitHub protection was verified through its API on 2026-08-23 IST (2026-08-22 UTC): checks are strict and apply to administrators; all three workflow jobs, linear history, and resolved conversations are required; force pushes and branch deletion are disabled. Vercel production deployment from merge commit `84c139f` was verified Ready at `https://roastlp.vercel.app`; Preview deployments require Vercel authentication. A unique-commit staging deployment, environment credential isolation, and rollback drill remain required before POR-8 is Done.

## Rollback

1. Declare the incident and stop new production promotion. If payments/data integrity may be affected, disable checkout without deleting transaction data.
2. Select the last known-good Vercel deployment built from a commit that passed required checks and promote it through Vercel's rollback/redeploy control.
3. Do not run `git reset --hard`, reverse a database migration, or restore an old database over new payment state.
4. If a forward-only migration is involved, deploy a compatible application first, then apply a reviewed corrective migration. Payment/webhook/job ledgers remain authoritative.
5. Reconcile captured payments, queued/stuck audits, emails and refunds after the rollback. Replay only through idempotent recovery operations.
6. Record the deployed commit, timestamps, impact, reconciliation result and follow-up ticket. Rotate secrets if exposure is suspected.

Run a staging rollback drill before live payment. POR-34 supplies production secret/backup hardening; POR-35 owns the controlled go-live drill.
