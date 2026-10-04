# SignalCore V1 — Foundation

Internal web application foundation for the SignalCore V1 product plan.

## Current milestone

Phase 0 — Foundation.

Implemented in this starter:
- responsive Next.js application shell
- Supabase email/password authentication and protected routes
- persistent project creation/listing backed by RLS
- Daily Inbox information architecture
- Owned / Client / Lead Prospect project types
- Projects screen and new-project UX
- placeholder modules for Opportunities, Issues, Sales, Automations and Settings
- current Supabase SSR client structure using publishable keys
- security-first foundation SQL for projects, sources, facts, jobs, findings, evidence, approvals, usage, budgets and audit events
- RLS policies scoped to the authenticated project owner

Not implemented yet:
- GSC/GA4 ingestion
- crawler
- LLM agents
- sales discovery

## Environment

Copy `.env.example` to `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

Never expose Supabase secret/service-role keys to the browser.

## Database

`supabase/schema/foundation.sql` has been applied to the SignalCore Supabase project and verified with RLS enabled on all foundation tables. Security Advisor is clean. Performance foreign-key index findings were resolved; unused-index INFO findings are expected on a fresh database.

## Next milestone

1. Add Project Brain source/fact ingestion.
2. Add project integration settings and GSC OAuth/property selection.
3. Implement incremental GSC ingestion and job history.
4. Add the first opportunity rules and findings inbox.
5. Add the Light HTTP Crawler after GSC is stable.
