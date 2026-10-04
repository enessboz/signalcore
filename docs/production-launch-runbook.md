# SignalCore Production Launch Runbook

This runbook is the final deployment and verification sequence for SignalCore after connecting the production Vercel account.

## 1. Production environment

Required environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `CRON_SECRET`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`

Recommended:

- `APP_URL` — stable production origin used by Google OAuth.
- `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` — required for Rank Tracking, live SERP research and Sales Discovery.
- `GITHUB_TOKEN` — required only for private repository context.
- `SERP_ESTIMATED_COST_PER_REQUEST_USD` — conservative pre-call estimate for SERP budget enforcement.

Never commit secret values to the repository.

## 2. Vercel connection

1. Import the GitHub repository into the final Vercel account.
2. Use the production branch selected for launch.
3. Copy required environment variables into Production.
4. Set `APP_URL` to the final production origin.
5. Deploy once without enabling external-impact actions.
6. Open `/preflight`.
7. Do not continue until every required preflight check is green.

SignalCore defines seven protected Vercel Cron routes in `vercel.json`:

- `/api/cron/data-sync`
- `/api/cron/technical-crawler`
- `/api/cron/rank-tracker`
- `/api/cron/opportunity-engine`
- `/api/cron/interventions`
- `/api/cron/agent-scheduler`
- `/api/cron/sales-discovery`

Every cron route requires the shared cron authorization secret.

## 3. Google OAuth

The production callback is:

`<APP_URL>/api/connections/google/callback`

Update the Google OAuth Web Client authorized redirect URI to the exact production callback before reconnecting Google.

Then:

1. Open Settings.
2. Reconnect Google.
3. Confirm GSC resources are discovered.
4. Confirm GA4 resources are discovered.
5. Confirm project bindings point to the intended GSC / GA4 resources.

Do not delete the existing encrypted refresh token during a deployment migration unless a full reconnect is intentionally required.

## 4. Supabase security

Before launch:

1. Confirm System Readiness reports no application-level security blocker.
2. Enable Supabase Auth leaked-password protection in the Supabase Auth dashboard.
3. Re-run Supabase security advisor.
4. Confirm all public application tables still have RLS enabled.
5. Confirm there are no RLS tables without policies.
6. Confirm there are no unvalidated production constraints.

Current schema is designed for owner-scoped data isolation. Runtime service-role access is server-only.

## 5. Cost controls

Before model/provider stress testing:

1. Configure at least one production budget in Costs & Budgets.
2. Set AI monthly hard-stop where appropriate.
3. Set SERP monthly hard-stop before enabling Rank Tracking or Sales Discovery.
4. Review any deterministic budget warning finding before raising a hard limit.
5. Keep Agent UAT to controlled single-scenario runs.

Sales Discovery also has its own campaign-level:

- max cost per run,
- monthly SERP budget,
- monthly hard-stop.

## 6. Agent UAT

Open `/agent-uat`.

Minimum smoke gate:

- At least one passing direct scenario for each of the seven specialist agents.
- At least three passing Router scenarios.
- No approval-gate failure.
- No evidence-integrity failure.

The full catalog contains 42 controlled scenarios:

- 35 direct specialist scenarios,
- 7 Router scenarios.

Project safety cap: 10 UAT runs per project per UTC day.

Do not use “run everything” behavior for launch validation. Run only enough scenarios to establish the smoke gate, inspect failures, then expand testing deliberately.

## 7. First-party data health

For every project with GSC or GA4 bindings:

1. Open the project Data Health workspace.
2. Confirm target date coverage is understood.
3. Confirm there are no failed sync jobs.
4. Confirm there are no unresolved failed ingestion dates.
5. Confirm missing dates are either actively queued/running or intentionally absent.
6. Confirm zero-row dates are recorded as successfully processed, not misclassified as gaps.

Do not trust comparison-based Opportunity Engine findings while warehouse coverage is unresolved.

## 8. Technical crawler

Scheduled crawls are production-bounded:

- safe execution deadline,
- partial completion before function timeout,
- sitemap rotation for broad large-site coverage,
- delta mode for change/regression monitoring.

For very large sites, do not treat one sample crawl as complete-site coverage. Use scheduled rotating samples and first-party URL inventories.

After the first production crawl:

1. Confirm the run completes or exits as controlled partial.
2. Confirm `runtime_limited` is understandable when present.
3. Confirm the next sitemap offset advances.
4. Confirm the next scheduled run rotates into a different sitemap segment.

## 9. Operations

Open `/operations` after at least one cron cycle.

Verify:

- no stale worker run older than 15 minutes,
- no repeated failed worker run,
- queue counts are moving,
- durations are plausible,
- owner-scoped worker history is populated,
- failed operations show actionable error messages.

Do not enable broader automation while Operations is showing unresolved repeated failures.

## 10. Native outputs

Generated outputs do not require another model call to download native files.

Expected behavior:

- presentation → PPTX,
- document / structured report → DOCX,
- Markdown remains available as fallback.

Validate one DOCX and one PPTX from real production output before launch sign-off.

## 11. Approval gate

External-impact actions must remain proposal-first.

Examples:

- deploy,
- publish,
- GitHub write,
- CMS write,
- delete,
- outreach send,
- other external system changes.

No agent response should claim an external action was completed unless an approved executor actually completed it.

## 12. Launch sign-off

Launch is ready when:

- Production Preflight has no required blocker.
- System Readiness has no core blocker.
- Agent UAT smoke gate passes.
- Operations completes at least one clean worker cycle.
- Bound projects show acceptable Data Health.
- Required cost hard-stops are configured.
- Supabase leaked-password protection is enabled.
- Google OAuth works on the final domain.
- One native DOCX and PPTX are validated.
- No repeated failed cron or stale worker state is present.

## 13. Rollback criteria

Pause production automation immediately if any of the following occur:

- repeated service-role or RLS errors,
- cross-owner data visibility,
- repeated cron overlap despite leases,
- unexpected paid-provider cost growth,
- approval-gate bypass,
- Google credential decryption/storage failure,
- persistent warehouse coverage corruption,
- crawler timeout without controlled partial completion,
- agent UAT evidence-integrity or approval failures that reproduce consistently.

When paused, keep deterministic read-only evidence collection enabled only if it is known to be safe and within budget.

## 14. Final activation order

1. Connect final Vercel account.
2. Configure environment.
3. Deploy.
4. Run Production Preflight.
5. Update and verify Google OAuth callback.
6. Reconnect Google if required.
7. Run Agent UAT smoke gate.
8. Observe one clean Operations cycle.
9. Validate Data Health.
10. Validate native outputs.
11. Enable leaked-password protection.
12. Re-run System Readiness.
13. Enable external-impact executors only behind explicit approval.
