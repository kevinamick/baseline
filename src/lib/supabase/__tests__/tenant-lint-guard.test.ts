import { describe, it, expect, vi } from "vitest";

// `import "server-only"` throws outside a server bundle.
vi.mock("server-only", () => ({}));
// admin.ts constructs a client from env at module load; the tuple is all we need.
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

import { TENANT_SCOPED_TABLES } from "@/lib/supabase/tenant-db";
import {
  TENANT_GUARD_TABLES,
  tenantGuardRestriction,
} from "../../../../eslint.tenant-guard.mjs";

// The ESLint config runs under plain Node and can't import tenant-db.ts, so the
// lint guard carries its own copy of the tenant-scoped table list. This parity
// test is what keeps the two in lockstep (the app↔worker model-registry pattern):
// adding a table to TENANT_SCOPED_TABLES without updating eslint.tenant-guard.mjs
// fails here, so a new tenant table can't silently escape the lint ban.
describe("tenant lint guard parity", () => {
  it("guards exactly the tenantDb tenant-scoped tables", () => {
    expect([...TENANT_GUARD_TABLES].sort()).toEqual(
      [...TENANT_SCOPED_TABLES].sort()
    );
  });

  it("bans every guarded table in the esquery selector", () => {
    // The selector embeds the tables as a regex alternation; assert each table
    // name appears so a hand-edited selector can't drop one while the exported
    // list stays correct.
    for (const table of TENANT_GUARD_TABLES) {
      expect(tenantGuardRestriction.selector).toContain(table);
    }
  });
});
