import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';
import { opencodeConfigDirCandidates, parseJsonc } from '../workspace/codegraph';

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

/** Discover opencode MCP servers from its config file (no HTTP). */
export async function discoverOpencodeMcp(
  opts: RoleCatalogOptions = {},
): Promise<CatalogSection<McpServerEntry>> {
  const dirs = opencodeConfigDirCandidates(opts.env, opts.platform, opts.home);
  let sawFile = false;
  for (const dir of dirs) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      let text: string;
      try {
        text = await readFile(join(dir, name), 'utf8');
      } catch {
        continue;
      }
      sawFile = true;
      let config: unknown;
      try {
        config = parseJsonc(text);
      } catch {
        continue;
      }
      return { available: true, items: opencodeMcpServers(config, name) };
    }
  }
  return {
    available: false,
    error: sawFile ? 'opencode 配置解析失败' : '未找到 opencode 配置',
    items: [],
  };
}

/** Parse an already-read opencode config object. Exported for tests. */
export function opencodeMcpServers(config: unknown, source: string): McpServerEntry[] {
  if (!config || typeof config !== 'object') return [];
  const mcp = (config as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return [];
  const map = mcp as Record<string, unknown>;
  const servers = map.servers;
  const entries: Array<[string, unknown]> =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? Object.entries(servers as Record<string, unknown>)
      : Object.entries(map).filter(([key]) => key !== 'servers');
  return entries.map(([name, value]) => ({ name, transport: opencodeTransport(value), source }));
}

function opencodeTransport(value: unknown): McpTransport {
  if (!value || typeof value !== 'object') return 'unknown';
  const rec = value as { type?: unknown; url?: unknown };
  if (rec.type === 'local') return 'stdio';
  if (rec.type === 'remote') {
    return typeof rec.url === 'string' && rec.url.includes('sse') ? 'sse' : 'http';
  }
  return 'unknown';
}
