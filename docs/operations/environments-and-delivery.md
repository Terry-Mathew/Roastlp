# Environments, protected delivery and rollback

- Status: Repository contract complete; provider/dashboard enforcement must be evidenced before POR-8 closes
- Runtime: Node.js 24 LTS, pnpm 11
- Linear: POR-8

## Environment contract

| Environment | Source                                     | Data/providers                                                                  | Purpose                                 | Deployment rule                                                     |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Local       | Developer checkout                         | Local/test credentials only; no production data                                 | Development and deterministic tests     | `.env.local` is ignored and created by the developer                |
| Preview     | Pull request                               | Isolated preview database branch and provider test credentials                  | Review each change                      | Vercel Preview; never production Razorpay keys or real buyer data   |
| Staging     | `main` or an explicit staging branch/alias | Persistent staging DB and provider test modes, isolated from preview/production | Integration, webhook and go-live drills | Deploy only after all required GitHub checks pass                   |
| Production  | Promoted tested commit                     | Production DB/regions and live credentials                                      | Live ₹199 service                       | Manual Vercel promotion only after required checks and launch gates |

`APP_ENV` is one of `local`, `preview`, `staging`, or `production`. `APP_URL` and `NEXT_PUBLIC_APP_URL` must name the same environment. Server startup validation will be added with provider integrations; a production process must refuse test keys and a non-production process must refuse live Razorpay keys.

`.env.example` is the canonical variable-name inventory and contains no values. Secrets live only in the relevant Vercel environment or local untracked file. Preview, staging and production use separate database branches and provider credentials.

## Required checks and deployment protection

Configure the GitHub default branch as `main` after the repository's first commit, then enable a ruleset that:

- requires a pull request and at least one approval;
- requires `Install, type-check, lint, test, audit and build`, `Secret scan`, and `Browser smoke test`;
- requires the branch to be current and conversations resolved;
- blocks force pushes and deletion; and
- applies to administrators unless an audited emergency bypass is used.

In Vercel, disable deployments whose Git commit is not from the protected repository/default branch. Production is a manual promotion, not an automatic deployment from an unchecked local branch. Keep live Razorpay credentials absent until every Linear `launch-blocker` is Done.

These controls cannot be proven by files alone. Add screenshots/exports of the GitHub ruleset and Vercel production-deployment settings to POR-8 before marking it Done.

## Rollback

1. Declare the incident and stop new production promotion. If payments/data integrity may be affected, disable checkout without deleting transaction data.
2. Select the last known-good Vercel deployment built from a commit that passed required checks and promote it through Vercel's rollback/redeploy control.
3. Do not run `git reset --hard`, reverse a database migration, or restore an old database over new payment state.
4. If a forward-only migration is involved, deploy a compatible application first, then apply a reviewed corrective migration. Payment/webhook/job ledgers remain authoritative.
5. Reconcile captured payments, queued/stuck audits, emails and refunds after the rollback. Replay only through idempotent recovery operations.
6. Record the deployed commit, timestamps, impact, reconciliation result and follow-up ticket. Rotate secrets if exposure is suspected.

Run a staging rollback drill before live payment. POR-34 supplies production secret/backup hardening; POR-35 owns the controlled go-live drill.
