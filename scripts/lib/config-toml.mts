/**
 * Shared config.toml section reader for the scoped Management-API push scripts
 * (`push-auth-email-templates.mts`, `push-auth-hook.mts`). A targeted section
 * read — rather than a full TOML parse — keeps those scripts dependency-free;
 * the values they read are plain TOML basic strings or bare booleans (#489, the
 * repo's no-duplicate-helpers rule: both scripts used to carry their own copy
 * of this extraction, diverging only in the value regex).
 */

/**
 * Read a single `field` out of the `[header]` section of a config.toml string
 * (`header` is the full bracketed table name, e.g.
 * `"[auth.email.template.confirmation]"`). The value may be quoted or bare: a
 * quoted value is captured verbatim between the outer quotes (basic strings
 * with no escapes round-trip exactly), a bare value (e.g. a boolean) is
 * captured as written and can be trimmed by the caller. Throws if the section
 * or the field line is absent.
 */
export function readConfigSectionField(
  toml: string,
  header: string,
  field: string,
): string {
  const start = toml.indexOf(header);
  if (start === -1) throw new Error(`config.toml is missing ${header}`);
  // The section runs until the next TOML table header (`\n[`) or end of file.
  const rest = toml.slice(start + header.length);
  const nextHeader = rest.search(/\n\[/);
  const section = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
  const match = section.match(
    new RegExp(`^${field}\\s*=\\s*(?:"(.*)"|([^"\\n]*))\\s*$`, "m"),
  );
  if (!match) throw new Error(`config.toml ${header} is missing a "${field}" line`);
  return match[1] ?? match[2];
}
