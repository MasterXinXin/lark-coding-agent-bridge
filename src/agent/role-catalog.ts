import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { profileAppPaths, type MutableProfileState } from '../config/config-ops';
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
  let parsed = 0;
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
    parsed += 1;
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const servers = (config as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({ name, transport: claudeTransport(value), source: label });
    }
  }
  if (read === 0) return { available: false, error: '未找到 ~/.claude.json 或 .mcp.json', items: [] };
  if (parsed === 0) return { available: false, error: 'claude 配置解析失败', items: [] };
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
    let entries: Dirent[];
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

/** MCP servers from `${codexHome}/config.toml` (`[mcp_servers.<name>]` tables). */
export async function discoverCodexMcp(codexHome: string): Promise<CatalogSection<McpServerEntry>> {
  let text: string;
  try {
    text = await readFile(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return { available: false, error: '未找到 config.toml', items: [] };
  }
  try {
    return { available: true, items: parseCodexMcpServers(text) };
  } catch {
    return { available: false, error: '解析 config.toml 失败', items: [] };
  }
}

/**
 * Minimal read-only TOML subset: only `[mcp_servers.<name>]` table headers and
 * a `url`/`command` key inside each. Quoted table keys, inline tables and
 * multi-line strings are unsupported (such entries are skipped, not errored).
 * Any other table header (nested sub-table, `[[...]]`, unrelated section) ends
 * the current server so its keys are not attributed elsewhere.
 */
export function parseCodexMcpServers(toml: string): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  const seen = new Set<string>();
  let current: McpServerEntry | null = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[\s*mcp_servers\.([A-Za-z0-9_-]+)\s*\]$/.exec(line);
    if (header) {
      const name = header[1]!;
      if (seen.has(name)) {
        current = null;
        continue;
      }
      seen.add(name);
      current = { name, transport: 'unknown', source: 'config.toml' };
      out.push(current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (/^url\s*=/.test(line)) current.transport = 'http';
    else if (/^command\s*=/.test(line) && current.transport === 'unknown') current.transport = 'stdio';
  }
  return out;
}

/** Remove a trailing `#` comment that is not inside a quoted string. */
function stripTomlComment(line: string): string {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inString) {
      if (ch === quote && line[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Discover the profile's MCP / skill catalog. Never throws; failures degrade to `available:false`. */
export async function buildRoleCatalog(
  state: MutableProfileState,
  opts: RoleCatalogOptions = {},
): Promise<RoleCatalogView> {
  const agentKind = state.profileConfig.agentKind;
  const capabilities = roleScope(agentKind);
  try {
    const home = opts.home ?? homedir();
    const appPaths = profileAppPaths(state);
    const workspaceDir = state.profileConfig.workspaces?.default ?? appPaths.defaultWorkspaceDir;
    const codexHome = state.profileConfig.codex?.codexHome ?? join(appPaths.profileDir, 'codex-home');

    let mcp: CatalogSection<McpServerEntry>;
    let skills: CatalogSection<SkillEntry>;
    switch (agentKind) {
      case 'opencode':
        mcp = await discoverOpencodeMcp(opts);
        skills = { available: false, error: '2b 支持', items: [] };
        break;
      case 'codex':
        mcp = await discoverCodexMcp(codexHome);
        skills = { available: false, error: '该桥接无 skill', items: [] };
        break;
      case 'claude':
        mcp = await discoverClaudeMcp({ home, workspaceDir });
        skills = await discoverClaudeSkills({ home, workspaceDir });
        break;
    }
    return { profile: state.profile, agentKind, capabilities, mcp, skills };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const empty = { available: false as const, error, items: [] };
    return { profile: state.profile, agentKind, capabilities, mcp: { ...empty }, skills: { ...empty } };
  }
}
