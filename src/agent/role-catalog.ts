import type { AgentKind } from '../config/profile-schema';

export type RoleScopeCapability = 'control' | 'readonly' | 'none';

export interface RoleCatalogCapabilities {
  mcp: RoleScopeCapability;
  skills: RoleScopeCapability;
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  /** Human-readable origin, e.g. `opencode.json`, `~/.claude.json`, `config.toml`. */
  source: string;
}

export interface SkillEntry {
  name: string;
  source: string;
}

export interface CatalogSection<T> {
  /** false = could not be read/parsed (items is empty). */
  available: boolean;
  /** Short reason shown in the UI when `available` is false. */
  error?: string;
  items: T[];
}

export interface RoleCatalogView {
  profile: string;
  agentKind: AgentKind;
  capabilities: RoleCatalogCapabilities;
  mcp: CatalogSection<McpServerEntry>;
  skills: CatalogSection<SkillEntry>;
}

/** Options for filesystem discovery; mirrors `mcpStatus` in `src/workspace/codegraph.ts`. */
export interface RoleCatalogOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

const ROLE_SCOPE: Record<AgentKind, RoleCatalogCapabilities> = {
  claude: { mcp: 'control', skills: 'readonly' },
  codex: { mcp: 'readonly', skills: 'none' },
  opencode: { mcp: 'control', skills: 'control' },
};

/** Per-agent MCP / skill control levels (2b uses these to decide what is switchable). */
export function roleScope(agentKind: AgentKind): RoleCatalogCapabilities {
  return { ...ROLE_SCOPE[agentKind] };
}
