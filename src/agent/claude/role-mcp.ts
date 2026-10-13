import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from '../../workspace/codegraph';

/**
 * Phase 2b: claude's `--mcp-config` needs the *full* server objects, not just
 * names. We read the same two sources the catalog lists, keeping the first
 * definition seen per name (matching `discoverClaudeMcp`'s de-dup order).
 */

export interface ClaudeMcpDefinitionPaths {
  home: string;
  workspaceDir: string;
}

/** Server definitions from `~/.claude.json` (top-level `mcpServers`) and `<workspace>/.mcp.json`. */
export function readClaudeMcpDefinitions(paths: ClaudeMcpDefinitionPaths): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const sources = [join(paths.home, '.claude.json'), join(paths.workspaceDir, '.mcp.json')];
  for (const file of sources) {
    let config: unknown;
    try {
      config = parseJsonc(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const servers = (config as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
      if (!out.has(name)) out.set(name, def);
    }
  }
  return out;
}

export interface ClaudeMcpConfigInput {
  /**
   * `undefined` = do not inject (follow native config); `[]` = serve no MCP
   * servers; a list = allow only those (strict). Mirrors the role tri-state.
   */
  mcpEnabled?: readonly string[];
  definitions: Map<string, unknown>;
}

export interface ClaudeMcpConfigResult {
  /** Passed via `--mcp-config <file> --strict-mcp-config`, or undefined to not inject. */
  config: { mcpServers: Record<string, unknown> } | undefined;
  /** Whitelisted names that had no definition on disk (cannot be passed through). */
  missing: string[];
}

/** Build the `--mcp-config` payload for a claude run. */
export function buildClaudeMcpConfig(input: ClaudeMcpConfigInput): ClaudeMcpConfigResult {
  if (input.mcpEnabled === undefined) return { config: undefined, missing: [] };

  const mcpServers: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of input.mcpEnabled) {
    if (input.definitions.has(name)) mcpServers[name] = input.definitions.get(name);
    else missing.push(name);
  }

  // An explicit allow-list where nothing resolved would make
  // `--strict-mcp-config` disable every server. Degrade open (follow native)
  // instead of locking the user out of servers we failed to read.
  if (input.mcpEnabled.length > 0 && Object.keys(mcpServers).length === 0) {
    return { config: undefined, missing };
  }
  return { config: { mcpServers }, missing };
}
