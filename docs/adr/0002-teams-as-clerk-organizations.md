# Teams are backed by Clerk Organizations

> **Status:** superseded-in-progress by [ADR-0005](./0005-supabase-auth-over-clerk.md). Clerk is being replaced by Supabase Auth; the Team/membership model migrates to native `organizations` + `memberships` tables in the orgs slice (#47). This ADR describes the original Clerk-backed design.

The app required a multi-user team model with membership management, role-based access, and an invitation flow. We already use Clerk for authentication, and Clerk Organizations provide all of this natively: org IDs travel in the JWT, membership and roles are managed via Clerk's API and dashboard, and invitation links handle the join flow without custom code.

We use Clerk's two built-in roles directly: `org:admin` maps to Contributor (full CRUD + member management) and `org:member` maps to Readonly Member (view only). No custom roles are defined.

## Considered options

A custom `teams` table in Supabase with a `team_members` join table would have given us more control, but it would have meant reimplementing membership management, invitation handling, and role propagation that Clerk already provides — and decoupling auth identity from team membership.

## Consequences

- No `teams` table. A minimal `organizations` table exists in Supabase solely as a FK anchor for `rubrics.org_id`, populated via the `organization.created` Clerk webhook.
- Every rubric must belong to a Team (`org_id` is NOT NULL). There are no personal rubrics.
- New users without an active org are gated in `proxy.ts` and redirected to `/onboarding` to create a team.
