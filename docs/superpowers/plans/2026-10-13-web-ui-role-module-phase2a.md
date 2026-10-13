# 控制台「角色」模块 · 二期 2a：MCP / Skill 目录发现与选择（只读） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「角色」页新增「MCP / Skill 范围」区：探测并展示该 profile 的 MCP server 与 skill，允许勾选并落盘保存（明确标注暂不强制生效）。

**Architecture:** 新增纯文件源的 `src/agent/role-catalog.ts`（按 `agentKind` 探测，绝不抛错，失败降级为 `available:false`）；`role-api.ts` 扩展为可回显/保存白名单（三态 body）；`server.ts` 增加 `GET /api/role/catalog`；前端 `RoleView.tsx` 增加一张卡。全程纯文件、零新依赖、不做任何强制注入。

**Tech Stack:** TypeScript（Node 20、ESM）、vitest、React + Vite + Radix UI。

**Spec:** `docs/superpowers/specs/2026-10-13-web-ui-role-module-phase2a-design.md`

---

### Task 1: `role-catalog.ts` 能力分级（从 `role-api.ts` 迁出）

**Files:**
- Create: `src/agent/role-catalog.ts`
- Modify: `src/ui/role-api.ts`（删除 `RoleScopeCapability` 定义与 `ROLE_SCOPE`，改从 role-catalog 导入）
- Test: `tests/unit/agent/role-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/role-catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roleScope } from '../../../src/agent/role-catalog';

describe('roleScope', () => {
  it('reports per-agent MCP / skill control levels', () => {
    expect(roleScope('claude')).toEqual({ mcp: 'control', skills: 'readonly' });
    expect(roleScope('codex')).toEqual({ mcp: 'readonly', skills: 'none' });
    expect(roleScope('opencode')).toEqual({ mcp: 'control', skills: 'control' });
  });

  it('returns a fresh object so callers cannot mutate the table', () => {
    const a = roleScope('claude');
    a.mcp = 'none';
    expect(roleScope('claude').mcp).toBe('control');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts`
Expected: FAIL — `src/agent/role-catalog.ts` does not exist.

- [ ] **Step 3: Implement the module skeleton**

Create `src/agent/role-catalog.ts`:

```ts
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
```

- [ ] **Step 4: Update `src/ui/role-api.ts` to import the matrix**

Replace the import block and delete the local `RoleScopeCapability` / `ROLE_SCOPE`:

```ts
import {
  claudeCapability,
  codexCapability,
  opencodeCapability,
  type AgentCapability,
  type PromptInjectionMode,
} from '../agent/capability';
import { roleScope, type RoleScopeCapability } from '../agent/role-catalog';
import type { MutableProfileState } from '../config/config-ops';
```

Delete lines defining `export type RoleScopeCapability = ...;` and the `const ROLE_SCOPE ... = {...};` block (the comment block above it too). In `buildRoleView`, change `capabilities: ROLE_SCOPE[agentKind],` to:

```ts
    capabilities: roleScope(agentKind),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts tests/unit/ui/role-api.test.ts tests/integration/ui/server.test.ts && pnpm typecheck`
Expected: PASS (all suites; the role-api/server tests confirm the moved matrix still works).

- [ ] **Step 6: Commit**

```bash
git add src/agent/role-catalog.ts src/ui/role-api.ts tests/unit/agent/role-catalog.test.ts
git commit -m "feat(agent): role catalog capability matrix"
```

---

### Task 2: opencode MCP 发现

**Files:**
- Modify: `src/agent/role-catalog.ts`
- Test: `tests/unit/agent/role-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/role-catalog.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { discoverOpencodeMcp, opencodeMcpServers } from '../../../src/agent/role-catalog';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'role-catalog-'));
  cleanups.push(dir);
  return dir;
}

describe('opencode MCP discovery', () => {
  it('reads server names (new `mcp.<name>` shape) and infers transport', () => {
    expect(
      opencodeMcpServers(
        {
          mcp: {
            local1: { type: 'local', command: ['node', 'x.js'] },
            remote1: { type: 'remote', url: 'https://example.com/sse' },
            remote2: { type: 'remote', url: 'https://example.com' },
          },
        },
        'opencode.json',
      ),
    ).toEqual([
      { name: 'local1', transport: 'stdio', source: 'opencode.json' },
      { name: 'remote1', transport: 'sse', source: 'opencode.json' },
      { name: 'remote2', transport: 'http', source: 'opencode.json' },
    ]);
  });

  it('reads the legacy `mcp.servers.<name>` shape', () => {
    expect(opencodeMcpServers({ mcp: { servers: { old: { type: 'local' } } } }, 'opencode.json')).toEqual([
      { name: 'old', transport: 'stdio', source: 'opencode.json' },
    ]);
  });

  it('returns an empty, available section when a config has no mcp', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    const section = await discoverOpencodeMcp({ env: { OPENCODE_CONFIG_DIR: dir } });
    expect(section).toEqual({ available: true, items: [] });
  });

  it('parses jsonc and reads the first candidate dir', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'opencode.jsonc'),
      '{\n  // comment\n  "mcp": { "cg": { "type": "local" } },\n}\n',
      'utf8',
    );
    const section = await discoverOpencodeMcp({ env: { OPENCODE_CONFIG_DIR: dir } });
    expect(section).toEqual({
      available: true,
      items: [{ name: 'cg', transport: 'stdio', source: 'opencode.jsonc' }],
    });
  });

  it('reports unavailable when no config exists', async () => {
    const dir = await tempDir();
    const section = await discoverOpencodeMcp({
      env: { OPENCODE_CONFIG_DIR: join(dir, 'nope') },
      home: dir,
    });
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
    expect(section.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts -t "opencode"`
Expected: FAIL — `discoverOpencodeMcp` / `opencodeMcpServers` not exported.

- [ ] **Step 3: Implement**

Add to `src/agent/role-catalog.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { opencodeConfigDirCandidates, parseJsonc } from '../workspace/codegraph';

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
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/role-catalog.ts tests/unit/agent/role-catalog.test.ts
git commit -m "feat(agent): discover opencode MCP servers from config"
```

---

### Task 3: claude MCP + skill 发现

**Files:**
- Modify: `src/agent/role-catalog.ts`
- Test: `tests/unit/agent/role-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/role-catalog.test.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { discoverClaudeMcp, discoverClaudeSkills } from '../../../src/agent/role-catalog';

describe('claude MCP + skill discovery', () => {
  it('merges ~/.claude.json and workspace .mcp.json, de-duplicating names', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'a' }, beta: { url: 'https://x' } } }),
      'utf8',
    );
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { beta: { command: 'b' }, gamma: { type: 'sse', url: 'https://y' } } }),
      'utf8',
    );

    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section.available).toBe(true);
    expect(section.items).toEqual([
      { name: 'alpha', transport: 'stdio', source: '~/.claude.json' },
      { name: 'beta', transport: 'http', source: '~/.claude.json' },
      { name: 'gamma', transport: 'sse', source: '.mcp.json' },
    ]);
  });

  it('reports unavailable when neither claude MCP file exists', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
  });

  it('lists skill directories from home and workspace', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(home, '.claude', 'skills', 'skill-a'), { recursive: true });
    await mkdir(join(workspace, '.claude', 'skills', 'skill-b'), { recursive: true });

    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section).toEqual({
      available: true,
      items: [
        { name: 'skill-a', source: '~/.claude/skills' },
        { name: 'skill-b', source: '.claude/skills' },
      ],
    });
  });

  it('treats "no skill directories" as an available empty result', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section).toEqual({ available: true, items: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts -t "claude"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Add to `src/agent/role-catalog.ts`:

```ts
import { readdir } from 'node:fs/promises';

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
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/role-catalog.ts tests/unit/agent/role-catalog.test.ts
git commit -m "feat(agent): discover claude MCP servers and skills"
```

---

### Task 4: codex MCP 发现（手写只读 TOML 子集）

**Files:**
- Modify: `src/agent/role-catalog.ts`
- Test: `tests/unit/agent/role-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/role-catalog.test.ts`:

```ts
import { discoverCodexMcp } from '../../../src/agent/role-catalog';

describe('codex MCP discovery', () => {
  it('extracts [mcp_servers.<name>] names and transport, ignoring comments', async () => {
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, 'config.toml'),
      [
        '# top comment',
        '[mcp_servers.docs]',
        'command = "docs-mcp"   # inline comment',
        '[mcp_servers.web]',
        'url = "https://example.com"',
        '',
        '[mcp_servers.docs.env]',
        'TOKEN = "x"',
        '',
      ].join('\n'),
      'utf8',
    );

    const section = await discoverCodexMcp(codexHome);
    expect(section).toEqual({
      available: true,
      items: [
        { name: 'docs', transport: 'stdio', source: 'config.toml' },
        { name: 'web', transport: 'http', source: 'config.toml' },
      ],
    });
  });

  it('reports unavailable when config.toml is missing', async () => {
    const codexHome = await tempDir();
    const section = await discoverCodexMcp(codexHome);
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts -t "codex"`
Expected: FAIL — `discoverCodexMcp` not exported.

- [ ] **Step 3: Implement**

Add to `src/agent/role-catalog.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/role-catalog.ts tests/unit/agent/role-catalog.test.ts
git commit -m "feat(agent): discover codex MCP servers from config.toml"
```

---

### Task 5: `buildRoleCatalog` 组合入口

**Files:**
- Modify: `src/agent/role-catalog.ts`
- Test: `tests/unit/agent/role-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/role-catalog.test.ts`:

```ts
import type { MutableProfileState } from '../../../src/config/config-ops';
import { buildRoleCatalog } from '../../../src/agent/role-catalog';

function fakeState(configPath: string, profileConfig: Record<string, unknown>): MutableProfileState {
  return {
    configPath,
    profile: 'p',
    cfg: {} as never,
    profileConfig: profileConfig as never,
  };
}

describe('buildRoleCatalog', () => {
  it('dispatches claude to claude discovery with the configured workspace', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(workspace, '.claude', 'skills', 's1'), { recursive: true });
    const state = fakeState(join(workspace, 'config.json'), {
      agentKind: 'claude',
      workspaces: { default: workspace },
    });
    const view = await buildRoleCatalog(state, { home });
    expect(view).toMatchObject({
      profile: 'p',
      agentKind: 'claude',
      capabilities: { mcp: 'control', skills: 'readonly' },
    });
    expect(view.skills.items).toEqual([{ name: 's1', source: '.claude/skills' }]);
  });

  it('dispatches codex to a read-only config.toml and no skills', async () => {
    const codexHome = await tempDir();
    await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n', 'utf8');
    const state = fakeState(join(codexHome, 'config.json'), {
      agentKind: 'codex',
      codex: { binaryPath: 'codex', codexHome },
    });
    const view = await buildRoleCatalog(state);
    expect(view.capabilities).toEqual({ mcp: 'readonly', skills: 'none' });
    expect(view.mcp.items).toEqual([{ name: 'x', transport: 'stdio', source: 'config.toml' }]);
    expect(view.skills).toEqual({ available: false, error: '该桥接无 skill', items: [] });
  });

  it('dispatches opencode to file discovery and defers skills to 2b', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ mcp: { a: { type: 'local' } } }), 'utf8');
    const state = fakeState(join(dir, 'config.json'), { agentKind: 'opencode' });
    const view = await buildRoleCatalog(state, { env: { OPENCODE_CONFIG_DIR: dir } });
    expect(view.capabilities).toEqual({ mcp: 'control', skills: 'control' });
    expect(view.mcp.items).toEqual([{ name: 'a', transport: 'stdio', source: 'opencode.json' }]);
    expect(view.skills.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts -t "buildRoleCatalog"`
Expected: FAIL — `buildRoleCatalog` not exported.

- [ ] **Step 3: Implement**

Add to `src/agent/role-catalog.ts`:

```ts
import { homedir } from 'node:os';
import { profileAppPaths, type MutableProfileState } from '../config/config-ops';

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
    const workspaceDir = state.profileConfig.workspaces.default ?? appPaths.defaultWorkspaceDir;
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/role-catalog.ts tests/unit/agent/role-catalog.test.ts
git commit -m "feat(agent): compose the role catalog view"
```

---

### Task 6: `role-api` 白名单回显 + 三态保存

**Files:**
- Modify: `src/ui/role-api.ts`
- Test: `tests/unit/ui/role-api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ui/role-api.test.ts` inside `describe('saveRoleConfig', ...)`:

```ts
  it('stores, echoes and clears the MCP / skill whitelists', async () => {
    const { configPath, state } = await createState();

    const set = await saveRoleConfig(state, { prompt: 'x', mcpEnabled: ['a', 'a', ' '], skillsEnabled: [] });
    expect(set.mcpEnabled).toEqual(['a']);
    expect(set.skillsEnabled).toEqual([]);
    expect(state.profileConfig.role).toEqual({ prompt: 'x', mcpEnabled: ['a'], skillsEnabled: [] });

    // omitted keys keep the existing selection
    const kept = await saveRoleConfig(state, { prompt: 'y' });
    expect(kept.mcpEnabled).toEqual(['a']);
    expect(kept.skillsEnabled).toEqual([]);

    // null clears back to "unlimited"
    const cleared = await saveRoleConfig(state, { prompt: 'y', mcpEnabled: null });
    expect(cleared.mcpEnabled).toBeUndefined();
    expect(cleared.skillsEnabled).toEqual([]);
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toEqual({
      prompt: 'y',
      skillsEnabled: [],
    });
  });

  it('400s a whitelist that is neither a string array nor null', async () => {
    const { state } = await createState();
    await expect(saveRoleConfig(state, { prompt: 'x', mcpEnabled: 42 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      saveRoleConfig(state, { prompt: 'x', skillsEnabled: [1, 2] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('echoes stored whitelists on the role view', async () => {
    const { state } = await createState();
    await saveRoleConfig(state, { prompt: 'x', mcpEnabled: ['a'] });
    expect(buildRoleView(state, true)).toMatchObject({ mcpEnabled: ['a'] });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/ui/role-api.test.ts -t "whitelist"`
Expected: FAIL — `RoleView` has no `mcpEnabled` / parse rejects `null`.

- [ ] **Step 3: Implement**

In `src/ui/role-api.ts`:

(a) Extend `RoleView`:

```ts
export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** How this agent injects the role (from its capability). */
  injection: PromptInjectionMode;
  /** How far MCP / skill scope can be controlled per bridge (2b enforces). */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  /** Stored MCP whitelist; absent = unrestricted. */
  mcpEnabled?: string[];
  /** Stored skill whitelist; absent = unrestricted. */
  skillsEnabled?: string[];
  live: boolean;
}
```

(b) In `buildRoleView`, add the echo (before `live,`):

```ts
    ...(state.profileConfig.role?.mcpEnabled !== undefined
      ? { mcpEnabled: state.profileConfig.role.mcpEnabled }
      : {}),
    ...(state.profileConfig.role?.skillsEnabled !== undefined
      ? { skillsEnabled: state.profileConfig.role.skillsEnabled }
      : {}),
```

(c) Replace `saveRoleConfig`'s merge block and `parseRoleBody` with the tri-state version. Add `normalizeRole` to the `../config/profile-schema` import. New merge (inside the lock, replacing the `const next = ...` through `delete next.role;` block):

```ts
      const existing = profile.role;
      const candidate: RoleConfig = {
        prompt: parsed.prompt,
        ...(parsed.mcpEnabled !== undefined
          ? { mcpEnabled: parsed.mcpEnabled }
          : existing?.mcpEnabled !== undefined
            ? { mcpEnabled: existing.mcpEnabled }
            : {}),
        ...(parsed.skillsEnabled !== undefined
          ? { skillsEnabled: parsed.skillsEnabled }
          : existing?.skillsEnabled !== undefined
            ? { skillsEnabled: existing.skillsEnabled }
            : {}),
      };
      const merged = normalizeRole(candidate);
      const next = { ...profile };
      if (merged) next.role = merged;
      else delete next.role;
```

and `parseRoleBody` (called before the try; rename its local to `parsed`):

```ts
interface ParsedRoleBody {
  prompt: string;
  /** Present iff the body supplied `mcpEnabled`; `null` = clear. */
  mcpEnabled?: string[] | null;
  /** Present iff the body supplied `skillsEnabled`; `null` = clear. */
  skillsEnabled?: string[] | null;
}

/** Parse `{ prompt, mcpEnabled?, skillsEnabled? }`; whitelists accept a string[] or null (clear). */
function parseRoleBody(body: unknown): ParsedRoleBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  const raw = body as { prompt?: unknown; mcpEnabled?: unknown; skillsEnabled?: unknown };
  if (typeof raw.prompt !== 'string') throw new HttpError(400, 'prompt must be a string');
  const parsed: ParsedRoleBody = {
    prompt: truncateUtf8(raw.prompt.trim(), ROLE_PROMPT_MAX_BYTES),
  };
  if (raw.mcpEnabled !== undefined) parsed.mcpEnabled = parseWhitelist(raw.mcpEnabled, 'mcpEnabled');
  if (raw.skillsEnabled !== undefined) {
    parsed.skillsEnabled = parseWhitelist(raw.skillsEnabled, 'skillsEnabled');
  }
  return parsed;
}

function parseWhitelist(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new HttpError(400, `${field} must be a string array or null`);
  }
  return value;
}
```

and change the `saveRoleConfig` first line from `const role = parseRoleBody(body);` to `const parsed = parseRoleBody(body);`.

> Note: normalization (trim/dedupe/drop-empty, prompt cap) is delegated to `normalizeRole`; explicit `[]` is preserved because an array (even empty) counts as present there.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run tests/unit/ui/role-api.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/role-api.ts tests/unit/ui/role-api.test.ts
git commit -m "feat(ui): echo and persist role MCP/skill whitelists"
```

---

### Task 7: 路由 `GET /api/role/catalog`

**Files:**
- Modify: `src/ui/server.ts`
- Test: `tests/integration/ui/server.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('ui server (supervisor-backed)', ...)` in `tests/integration/ui/server.test.ts`:

```ts
  it('returns the role catalog shape for the active profile', async () => {
    const res = await get('/api/role/catalog', handle.token);
    expect(res.status).toBe(200);
    const catalog = await json(res);
    expect(catalog).toMatchObject({
      profile: 'claude',
      agentKind: 'claude',
      capabilities: { mcp: 'control', skills: 'readonly' },
    });
    expect(catalog.mcp).toHaveProperty('available');
    expect(Array.isArray(catalog.mcp.items)).toBe(true);
    expect(catalog.skills).toHaveProperty('available');
  });

  it('404s the catalog for an unknown profile', async () => {
    expect((await get('/api/role/catalog?profile=ghost', handle.token)).status).toBe(404);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/integration/ui/server.test.ts -t "catalog"`
Expected: FAIL — `/api/role/catalog` falls through to 404 for the active profile.

- [ ] **Step 3: Implement**

In `src/ui/server.ts`, add the import next to the role import:

```ts
import { buildRoleCatalog } from '../agent/role-catalog';
```

Insert immediately after the existing `POST /api/role` block:

```ts
  // --- role catalog (MCP / skill discovery, read-only) ---
  if (path === '/api/role/catalog' && g) {
    const { state } = await resolveTargetState(deps, url);
    sendJson(res, 200, await buildRoleCatalog(state));
    return;
  }
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run tests/integration/ui/server.test.ts && pnpm typecheck`
Expected: PASS (no regression in the file).

- [ ] **Step 5: Commit**

```bash
git add src/ui/server.ts tests/integration/ui/server.test.ts
git commit -m "feat(ui): route GET /api/role/catalog"
```

---

### Task 8: 前端「MCP / Skill 范围」卡

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/views/RoleView.tsx`

- [ ] **Step 1: Add the view types**

In `web/src/lib/types.ts`, replace the existing `RoleScopeCapability` + `RoleView` block (after `PromptInjectionMode`) with:

```ts
export type RoleScopeCapability = "control" | "readonly" | "none";

export type McpTransport = "stdio" | "http" | "sse" | "unknown";

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  source: string;
}

export interface SkillEntry {
  name: string;
  source: string;
}

export interface CatalogSection<T> {
  available: boolean;
  error?: string;
  items: T[];
}

/** Per-profile role (system-prompt soft constraint) + scope catalog. */
export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** How this agent injects the role. */
  injection: PromptInjectionMode;
  /** How far MCP / skill scope can be controlled. */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  /** Stored MCP whitelist; absent = unrestricted. */
  mcpEnabled?: string[];
  /** Stored skill whitelist; absent = unrestricted. */
  skillsEnabled?: string[];
  /** True when this profile's process hosts the UI (edits apply live). */
  live: boolean;
}

/** GET /api/role/catalog response. */
export interface RoleCatalogView {
  profile: string;
  agentKind: AgentKind;
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  mcp: CatalogSection<McpServerEntry>;
  skills: CatalogSection<SkillEntry>;
}
```

- [ ] **Step 2: Rewrite `web/src/views/RoleView.tsx`**

Replace the whole file with:

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type {
  CatalogSection,
  RoleCatalogView,
  RoleView as RoleViewModel,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";

const INJECTION_LABEL: Record<string, string> = {
  "append-system-prompt": "追加系统提示文件",
  "stdin-prefix": "前缀进标准输入",
  "prompt-body-system": "每轮 system 字段",
};

/** Stored selection → checked set. Absent whitelist means "unlimited" (all on). */
function initialChosen(items: Array<{ name: string }>, stored?: string[]): Set<string> {
  if (stored === undefined) return new Set(items.map((i) => i.name));
  const names = new Set(items.map((i) => i.name));
  return new Set(stored.filter((n) => names.has(n)));
}

/** Checked set → request body value: all = null (unrestricted), else the checked subset. */
function chosenToBody(chosen: Set<string>, names: string[]): string[] | null {
  if (names.every((n) => chosen.has(n))) return null;
  return names.filter((n) => chosen.has(n));
}

function ScopeSection({
  title,
  capability,
  section,
  chosen,
  onToggle,
}: {
  title: string;
  capability: "control" | "readonly" | "none";
  section: CatalogSection<{ name: string; transport?: string; source: string }>;
  chosen: Set<string>;
  onToggle: (name: string) => void;
}) {
  if (capability === "none") return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {!section.available ? (
        <p className="text-xs text-muted-foreground">{section.error ?? "无法读取"}（重试见上）。</p>
      ) : section.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">未发现条目。</p>
      ) : (
        <div className="space-y-1">
          {section.items.map((item) => (
            <label key={item.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">
                {item.name}
                {item.transport ? <span className="text-muted-foreground"> · {item.transport}</span> : null}
                <span className="text-muted-foreground"> · {item.source}</span>
              </span>
              <Switch
                checked={chosen.has(item.name)}
                disabled={capability !== "control"}
                onCheckedChange={() => onToggle(item.name)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoleView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<RoleViewModel | null>(null);
  const [catalog, setCatalog] = useState<RoleCatalogView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mcpChosen, setMcpChosen] = useState<Set<string>>(new Set());
  const [skillsChosen, setSkillsChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setCatalogError(null);
    let v: RoleViewModel;
    try {
      v = await apiGet<RoleViewModel>(`/api/role?${q}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return;
    }
    setView(v);
    setPrompt(v.prompt);
    try {
      const c = await apiGet<RoleCatalogView>(`/api/role/catalog?${q}`);
      setCatalog(c);
      setMcpChosen(initialChosen(c.mcp.items, v.mcpEnabled));
      setSkillsChosen(initialChosen(c.skills.items, v.skillsEnabled));
    } catch (e) {
      setCatalog(null);
      setCatalogError(String((e as Error).message ?? e));
    }
  }, [q]);
  useEffect(() => {
    void load();
  }, [load]);

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, name: string) {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setter(next);
  }

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { prompt };
      if (catalog && view) {
        if (view.capabilities.mcp === "control" && catalog.mcp.available) {
          body.mcpEnabled = chosenToBody(mcpChosen, catalog.mcp.items.map((i) => i.name));
        }
        if (view.capabilities.skills === "control" && catalog.skills.available) {
          body.skillsEnabled = chosenToBody(skillsChosen, catalog.skills.items.map((i) => i.name));
        }
      }
      const v = await apiPost<RoleViewModel>(`/api/role?${q}`, body);
      setView(v);
      setPrompt(v.prompt);
      toast.success("已保存角色设定");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!view) return <p className="text-muted-foreground text-sm">加载中…</p>;

  const liveText = view.live ? "保存后下一轮运行生效" : "该 profile 未在线，保存后下次启动生效";
  const showScope = view.capabilities.mcp !== "none" || view.capabilities.skills !== "none";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>角色设定</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            这是该 profile 的系统提示词软限制：作为「## 角色设定」段追加在 bridge 运行约定之后，对每次运行生效，
            用于约束 agent 的身份与风格。它不是硬权限——真正的权限在「配置」页的访问控制里。
          </p>
          <p className="text-xs text-muted-foreground">
            注入方式：{INJECTION_LABEL[view.injection] ?? view.injection} · {liveText}
          </p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：你是一名严谨的财务分析师，回答用中文，先给结论再给依据。"
          />
        </CardContent>
      </Card>

      {showScope ? (
        <Card>
          <CardHeader>
            <CardTitle>MCP / Skill 范围</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              勾选会保存到该 profile，但<strong>当前仅保存选择，尚未强制生效</strong>（将在二期 2b 落地）。
              全选 = 不限制；全部取消 = 全部禁用。
            </p>
            {catalogError ? (
              <p className="text-destructive text-sm">
                目录拉取失败：{catalogError}{" "}
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  重试
                </Button>
              </p>
            ) : catalog ? (
              <>
                <ScopeSection
                  title="MCP servers"
                  capability={view.capabilities.mcp}
                  section={catalog.mcp}
                  chosen={mcpChosen}
                  onToggle={(n) => toggle(mcpChosen, setMcpChosen, n)}
                />
                <ScopeSection
                  title="Skills"
                  capability={view.capabilities.skills}
                  section={catalog.skills}
                  chosen={skillsChosen}
                  onToggle={(n) => toggle(skillsChosen, setSkillsChosen, n)}
                />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">目录加载中…</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json && pnpm build:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/types.ts web/src/views/RoleView.tsx
git commit -m "feat(web): MCP / skill scope card in the role tab"
```

---

### Task 9: 文档

**Files:**
- Modify: `README.zh.md` (「控制台：角色」小节)
- Modify: `README.md` (the "Console: role" section)

- [ ] **Step 1: Chinese README**

In `README.zh.md`, in the `### 控制台：角色` section, after the existing bullets (before `## 权限模式`), append:

```md
- 「角色」页还列出现该 profile 的 **MCP server 与 skill**，并允许勾选生效范围。一期（2a）**只保存选择、尚未强制生效**；真正的按 profile 限制在二期 2b 落地。目录来自本地配置文件（opencode `opencode.json(c)`、claude `~/.claude.json` 与工作区 `.mcp.json`、codex `config.toml`），探测失败会提示可重试，不影响角色本身。
```

- [ ] **Step 2: English README**

In `README.md`, in the `### Console: role` section, after the existing bullets (before `## Permission modes`), append:

```md
- The Role tab also lists the profile's **MCP servers and skills** and lets you pick which apply. Phase 2a **only stores the selection — it is not enforced yet**; per-profile restriction lands in phase 2b. The catalog is read from local config files (opencode `opencode.json(c)`, claude `~/.claude.json` and the workspace `.mcp.json`, codex `config.toml`); a failed probe shows a retry hint and never affects the role itself.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: document the role MCP/skill scope (2a)"
```

---

### Task 10: 全量验证

**Files:** none (verification only)

- [ ] **Step 1: Focused suites**

Run: `pnpm exec vitest run tests/unit/agent/role-catalog.test.ts tests/unit/ui/role-api.test.ts tests/integration/ui/server.test.ts tests/unit/config/role-schema.test.ts`
Expected: PASS.

- [ ] **Step 2: Broader suites**

Run: `pnpm exec vitest run tests/unit/agent tests/unit/ui tests/integration/ui tests/unit/config`
Expected: PASS.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (web bundle + tsup output).

- [ ] **Step 4: Confirm no enforcement was accidentally added**

Run: `rg -n "mcp-config|strict-mcp-config|OPENCODE_CONFIG|body.tools" src`
Expected: no matches (2a must not inject anything).

- [ ] **Step 5: Confirm the tree is clean**

Run: `git status --short`
Expected: no tracked changes (build output is gitignored).

---

## Notes for the implementer

- **Never throw from the catalog.** Every file read/parse is wrapped; a failure returns `{ available:false, error, items:[] }`. The route must stay 200.
- **Pure files, zero deps, no HTTP.** Do not call opencode endpoints, do not add a TOML library, do not write to any user agent config dir.
- **Tri-state whitelists.** `undefined` = keep, `null` = clear (unrestricted), `[]` = none, `string[]` = set. The merge + `normalizeRole` is the single normalization point; do not re-implement trimming/dedupe in `role-api`.
- **Capability matrix lives in `role-catalog.ts`.** `role-api.ts` imports `roleScope`; do not reintroduce a local table.
- **`pnpm test` (whole suite) has known flakiness on this machine**; use the focused suites + `pnpm typecheck && pnpm build` as the gate.
- **Phase 2b (out of scope):** actual enforcement (`claude --mcp-config`, opencode `tools` map / `OPENCODE_CONFIG`). 2a only fixes the data shapes and the selection contract.
