#!/usr/bin/env python3
"""Ship the styled, locale-aware Supabase Auth email templates to the linked
prod project via a SCOPED Management API PATCH.

Sources the subject lines and body HTML straight from supabase/config.toml (the
single source of truth) and sends ONLY the mailer_subjects_* /
mailer_templates_*_content fields. It deliberately touches no other auth config,
so it cannot disable Dashboard-configured OAuth providers or clobber the redirect
allow-list the way `supabase config push` (all-or-nothing) would. See AGENTS.md.
"""
import json
import os
import sys
import tomllib
import urllib.error
import urllib.request

CONFIG_PATH = "supabase/config.toml"
# config.toml [auth.email.template.<key>] -> Management API field stem (identical).
TEMPLATES = ["confirmation", "email_change", "recovery", "reauthentication"]


def main() -> int:
    ref = os.environ["SUPABASE_PROJECT_ID_PROD"]
    token = os.environ["SUPABASE_ACCESS_TOKEN"]

    with open(CONFIG_PATH, "rb") as f:
        cfg = tomllib.load(f)
    templates = cfg["auth"]["email"]["template"]

    body = {}
    for key in TEMPLATES:
        t = templates[key]
        path = t["content_path"]
        if path.startswith("./"):
            path = path[2:]
        with open(path, "r", encoding="utf-8") as cf:
            body[f"mailer_templates_{key}_content"] = cf.read()
        body[f"mailer_subjects_{key}"] = t["subject"]

    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/config/auth",
        data=json.dumps(body).encode("utf-8"),
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"Updated {len(TEMPLATES)} auth email templates (HTTP {resp.status})")
    except urllib.error.HTTPError as e:
        print(f"PATCH failed: HTTP {e.code}\n{e.read().decode(errors='replace')}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"PATCH failed: {e.reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
