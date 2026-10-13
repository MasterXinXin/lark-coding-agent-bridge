import { readdir, readFile } from 'node:fs/promises';
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

export interface ClaudeCatalogPaths {
  home: string;
  workspaceDir: string;
}

/** MCP servers from `~/.claude.json` (top-level `mcpServers`) and `<workspace>/.mcp.json`. */
export async function discoverClaudeMcp(
  paths: ClaudeCatalogPaths,
): Promise<CatalogSection<McpServerEntry>> {
  const sources: Array<[string, string]> = [
    [join(paths.home, '.claude.json'), '~/.claude.json'],
    [join(paths.workspaceDir, '.mcp.json'), '.mcp.json'],
  ];
  const items: McpServerEntry[] = [];
  const seen = new Set<string>();
  let read = 0;
  for (const [file, label] of sources) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    read += 1;
    let config: unknown;
    try {
      config = parseJsonc(text);
    } catch {
      continue;
    }
    const servers = (config as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({ name, transport: claudeTransport(value), source: label });
    }
  }
  if (read === 0) return { available: false, error: '未找到 ~/.claude.json 或 .mcp.json', items: [] };
  return { available: true, items };
}

function claudeTransport(value: unknown): McpTransport {
  if (!value || typeof value !== 'object') return 'unknown';
  const rec = value as { type?: unknown; url?: unknown; command?: unknown };
  if (rec.type === 'sse') return 'sse';
  if (rec.type === 'http') return 'http';
  if (typeof rec.url === 'string') return rec.url.includes('sse') ? 'sse' : 'http';
  if (rec.command !== undefined) return 'stdio';
  return 'unknown';
}

/** Skill directory names from `~/.claude/skills` and `<workspace>/.claude/skills`. */
export async function discoverClaudeSkills(
  paths: ClaudeCatalogPaths,
): Promise<CatalogSection<SkillEntry>> {
  const sources: Array<[string, string]> = [
    [join(paths.home, '.claude', 'skills'), '~/.claude/skills'],
    [join(paths.workspaceDir, '.claude', 'skills'), '.claude/skills'],
  ];
  const items: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const [dir, label] of sources) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      items.push({ name: entry.name, source: label });
    }
  }
  return { available: true, items };
}
