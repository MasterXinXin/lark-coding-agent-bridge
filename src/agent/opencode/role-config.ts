/**
 * Phase 2b: turn a profile's MCP / skill whitelist into an opencode config
 * fragment that the bridge injects via `OPENCODE_CONFIG`.
 *
 * Why permissions (v2) instead of `disabled`:
 *   opencode v2 appends permission rules across config sources and matches
 *   last-wins, so a `deny` on `<server>_*` hides the server's tools without
 *   disconnecting it. Writing `mcp.servers.<name>.disabled: true` instead
 *   risks a higher-precedence project config replacing the whole server object
 *   and silently dropping the disable.
 *
 * v1 has no permission table; its only lever is `mcp.<name>.enabled = false`.
 *
 * Semantics (mirrors `normalizeRole`):
 *   - `undefined` = follow native config (inject nothing)
 *   - `[]`        = disable everything known
 *   - `string[]`  = allow only the listed names
 *
 * Only names present in `known*` can be denied — we never invent a wildcard
 * that could nuke unrelated tools (e.g. `*_*` would also match actions like
 * `external_directory`).
 */

export interface OpencodeRoleConfigInput {
  /** Allowed MCP server names; undefined = unrestricted. */
  mcpEnabled?: readonly string[];
  /** Allowed skill IDs; undefined = unrestricted. */
  skillsEnabled?: readonly string[];
  /** Server names discovered from opencode config (the deniable universe). */
  knownMcp: readonly string[];
  /** Skill IDs discovered from opencode skill sources. */
  knownSkills: readonly string[];
}

export interface OpencodeRoleInjection {
  /** Config fragment to write to the `OPENCODE_CONFIG` file, or undefined when unrestricted. */
  config: Record<string, unknown> | undefined;
  /** Known MCP servers left out of the whitelist (denied). */
  deniedMcp: string[];
  /** Known skills left out of the whitelist (denied). */
  deniedSkills: string[];
}

/** Names in `known` that the whitelist excludes; empty when unrestricted. */
function deniedNames(known: readonly string[], enabled: readonly string[] | undefined): string[] {
  if (enabled === undefined) return [];
  const allow = new Set(enabled);
  return [...new Set(known)].filter((name) => !allow.has(name));
}

/** opencode v2: `permissions` deny rules for MCP tools and skills. */
export function buildOpencodeV2RoleConfig(input: OpencodeRoleConfigInput): OpencodeRoleInjection {
  const deniedMcp = deniedNames(input.knownMcp, input.mcpEnabled);
  const deniedSkills = deniedNames(input.knownSkills, input.skillsEnabled);
  const permissions = [
    ...deniedMcp.map((name) => ({ action: `${name}_*`, resource: '*', effect: 'deny' })),
    ...deniedSkills.map((id) => ({ action: 'skill', resource: id, effect: 'deny' })),
  ];
  if (permissions.length === 0) {
    return { config: undefined, deniedMcp, deniedSkills };
  }
  return { config: { permissions }, deniedMcp, deniedSkills };
}

/** opencode v1: `mcp.<name>.enabled = false` (v1 has no skill config). */
export function buildOpencodeV1RoleConfig(input: OpencodeRoleConfigInput): OpencodeRoleInjection {
  const deniedMcp = deniedNames(input.knownMcp, input.mcpEnabled);
  const deniedSkills = deniedNames(input.knownSkills, input.skillsEnabled);
  if (deniedMcp.length === 0) {
    return { config: undefined, deniedMcp, deniedSkills };
  }
  const mcp: Record<string, unknown> = {};
  for (const name of deniedMcp) mcp[name] = { enabled: false };
  return { config: { mcp }, deniedMcp, deniedSkills };
}

/** Pick the builder for the detected opencode API generation. */
export function buildOpencodeRoleConfig(
  apiVersion: 1 | 2,
  input: OpencodeRoleConfigInput,
): OpencodeRoleInjection {
  return apiVersion === 2 ? buildOpencodeV2RoleConfig(input) : buildOpencodeV1RoleConfig(input);
}
