# Console Role Module — Phase 1 (role system prompt, three bridges) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-profile **role** (a system-prompt soft constraint) editable from a new "角色" tab in the console profile detail page, injected into every agent run for claude / codex / opencode (v1 and v2).

**Architecture:** Persist `role` on the profile config; compose a `## 角色设定` section onto the existing bridge system prompt via one shared `composeSystemPrompt`; carry it through `RunPolicyAllow.rolePrompt` → `AgentRunOptions.rolePrompt` → the three adapters' existing injection points. Read/save through a new `src/ui/role-api.ts` reusing the `MutableProfileState` + `withConfigFileLock` pattern so online profiles take effect on the next run without a restart.

**Tech Stack:** TypeScript, Node `node:http` UI server, React + Vite + Radix UI, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-13-web-ui-role-module-design.md`

**Worktree:** work in-place on `main` in `D:\code\lark-coding-agent-bridge`.

**Scope:** This is **phase 1 only** (the role prompt, all three bridges). Phase 2 (MCP/skill catalog + whitelist, §9 of the spec) gets its own plan; the config fields `mcpEnabled` / `skillsEnabled` are modeled now but not written by the phase-1 UI, and `RoleView.capabilities` is already populated so phase 2 adds data, not types.

---

### Task 1: role config model + persistence round-trip

**Files:**
- Modify: `src/config/profile-schema.ts` (interface near `MeetingConfig`; normalizer near `normalizeMeeting`; return object of `normalizeProfileConfig`)
- Modify: `src/config/profile-store.ts:48-106` (the storage whitelist MUST include `role`, or `saveRootConfig` silently drops it)
- Create: `tests/unit/config/role-schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/config/role-schema.test.ts`:

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  normalizeRole,
} from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('normalizeRole', () => {
  it('trims the prompt and drops an empty role with no whitelists', () => {
    expect(normalizeRole({ prompt: '   ' })).toBeUndefined();
    expect(normalizeRole({})).toBeUndefined();
    expect(normalizeRole(undefined)).toBeUndefined();
  });

  it('keeps a trimmed prompt', () => {
    expect(normalizeRole({ prompt: '  你是财务助手。 ' })).toEqual({ prompt: '你是财务助手。' });
  });

  it('distinguishes a missing whitelist from an explicit empty one', () => {
    // missing = follow native config → field omitted
    expect(normalizeRole({ prompt: 'x' })).toEqual({ prompt: 'x' });
    // explicit empty = disable everything → field kept as []
    expect(normalizeRole({ prompt: '', mcpEnabled: [] })).toEqual({ prompt: '', mcpEnabled: [] });
  });

  it('trims, dedupes, and drops empty whitelist names', () => {
    expect(normalizeRole({ prompt: 'x', skillsEnabled: [' a ', 'a', '', 'b'] })).toEqual({
      prompt: 'x',
      skillsEnabled: ['a', 'b'],
    });
  });
});

describe('normalizeProfileConfig role', () => {
  it('preserves a valid role and drops an empty one', () => {
    const withRole = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      role: { prompt: '你是助手' },
    });
    expect(withRole.role).toEqual({ prompt: '你是助手' });

    const withoutRole = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      role: { prompt: '   ' },
    });
    expect(withoutRole.role).toBeUndefined();
  });
});

describe('role persistence', () => {
  it('round-trips role through save/load', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'bridge-role-'));
    cleanups.push(rootDir);
    await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
    const configPath = join(rootDir, 'config.json');

    const root = createRootConfig(
      'claude',
      createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    );
    root.profiles.claude!.role = { prompt: '你是财务助手', mcpEnabled: [] };
    await saveRootConfig(root, configPath);

    const disk = (await loadRootConfig(configPath))!;
    expect(disk.profiles.claude!.role).toEqual({ prompt: '你是财务助手', mcpEnabled: [] });

    delete disk.profiles.claude!.role;
    await saveRootConfig(disk, configPath);
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/config/role-schema.test.ts`
Expected: FAIL — `normalizeRole` is not exported; `ProfileConfig.role` is not a known property.

- [ ] **Step 3: Add the config model**

In `src/config/profile-schema.ts`, add the interface after `MeetingConfig` (before `LarkCliIdentityPreset`):

```ts
/**
 * The profile's role — a system-prompt soft constraint injected into every
 * agent run (see `composeSystemPrompt`). Not a hard permission. The whitelist
 * fields are phase 2 (MCP / skill scope); missing = follow native config,
 * an explicit empty array = disable everything.
 */
export interface RoleConfig {
  /** Role system prompt (soft constraint). Empty after trim = not injected. */
  prompt: string;
  /** Phase 2: MCP servers allowed for this profile. Missing = follow native config. */
  mcpEnabled?: string[];
  /** Phase 2: skills allowed for this profile. Missing = follow native config. */
  skillsEnabled?: string[];
}

/** Upper bound for the role prompt, enforced on save. */
export const ROLE_PROMPT_MAX_BYTES = 64 * 1024;
```

Add `role?: RoleConfig;` to `ProfileConfig` (after `meeting`):

```ts
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  /** Role (system-prompt soft constraint) injected into every run. */
  role?: RoleConfig;
  larkCli: LarkCliConfig;
```

Add the normalizer after `normalizeMeeting`:

```ts
/**
 * Normalize a role. Returns `undefined` when there is nothing to store
 * (empty prompt and no whitelists) so the config stays clean.
 */
export function normalizeRole(input: unknown): RoleConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as { prompt?: unknown; mcpEnabled?: unknown; skillsEnabled?: unknown };
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const mcpEnabled = normalizeNameList(raw.mcpEnabled);
  const skillsEnabled = normalizeNameList(raw.skillsEnabled);
  if (!prompt && !mcpEnabled && !skillsEnabled) return undefined;
  return {
    prompt,
    ...(mcpEnabled ? { mcpEnabled } : {}),
    ...(skillsEnabled ? { skillsEnabled } : {}),
  };
}

/** `undefined` = field absent (follow native). Array (possibly empty) = explicit whitelist. */
function normalizeNameList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
```

In `normalizeProfileConfig`, add `role?: unknown;` to the `raw` type (after `meeting?: unknown;`), compute it next to `meeting`:

```ts
  const meeting = normalizeMeeting(raw.meeting);
  const role = normalizeRole(raw.role);
```

and add it to the returned object (after `meeting,`):

```ts
    comments,
    meeting,
    ...(role ? { role } : {}),
    larkCli,
```

- [ ] **Step 4: Add `role` to the storage whitelist**

In `src/config/profile-store.ts`, add `role` to the `StoredProfileConfig` union:

```ts
  | 'meeting'
  | 'role'
  | 'larkCli'
```

and emit it in `serializeProfileConfig` (after `meeting:`):

```ts
    meeting: profile.meeting,
    ...(profile.role ? { role: profile.role } : {}),
    larkCli: profile.larkCli,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/config/role-schema.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/profile-schema.ts src/config/profile-store.ts tests/unit/config/role-schema.test.ts
git commit -m "feat(config): add the profile role (system-prompt soft constraint)"
```

---

### Task 2: `composeSystemPrompt` + role-aware `prefixBridgeSystemPrompt`

**Files:**
- Modify: `src/agent/bridge-system-prompt.ts:137-148`
- Test: `tests/unit/agent/bridge-system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/agent/bridge-system-prompt.test.ts`, extend the import (line 2-6) to include `composeSystemPrompt`:

```ts
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  composeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
```

Append at the end of the file:

```ts
describe('composeSystemPrompt role section', () => {
  it('returns the bridge prompt unchanged when the role is missing or blank', () => {
    expect(composeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
    expect(composeSystemPrompt(undefined, '   ')).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a trimmed ## 角色设定 section after the bridge rules and identity', () => {
    const out = composeSystemPrompt({ openId: 'ou_me' }, '  你是财务助手。  ');

    expect(out).toContain('lark-channel-bridge 运行约定');
    expect(out).toContain('## 角色设定');
    expect(out).toContain('你是财务助手。');
    expect(out).not.toContain('  你是财务助手。'); // trimmed
    expect(out.indexOf('## 角色设定')).toBeGreaterThan(out.indexOf('## 你的身份'));
  });
});

describe('prefixBridgeSystemPrompt role section', () => {
  it('inserts the role before ## user_message', () => {
    const out = prefixBridgeSystemPrompt('hello', { openId: 'ou_me' }, '你是助手');

    expect(out).toContain('## 角色设定');
    expect(out.indexOf('## 角色设定')).toBeLessThan(out.indexOf('## user_message'));
    expect(out.endsWith('## user_message\n\nhello')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/agent/bridge-system-prompt.test.ts`
Expected: FAIL — `composeSystemPrompt` is not exported; `prefixBridgeSystemPrompt` ignores a third argument.

- [ ] **Step 3: Implement `composeSystemPrompt` and extend the prefix helper**

Replace the tail of `src/agent/bridge-system-prompt.ts` (from `export function prefixBridgeSystemPrompt` to the end) with:

```ts
/**
 * Bridge run conventions plus the optional role section. All three adapters
 * call this so the role is composed in exactly one place.
 */
export function composeSystemPrompt(
  identity: AgentBotIdentity | undefined,
  rolePrompt?: string,
): string {
  const base = buildBridgeSystemPrompt(identity);
  const role = rolePrompt?.trim();
  if (!role) return base;
  return `${base}\n## 角色设定\n\n${role}\n`;
}

export function prefixBridgeSystemPrompt(
  prompt: string,
  identity: AgentBotIdentity | undefined,
  rolePrompt?: string,
): string {
  return `${composeSystemPrompt(identity, rolePrompt)}\n\n## user_message\n\n${prompt}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/agent/bridge-system-prompt.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/agent/bridge-system-prompt.ts tests/unit/agent/bridge-system-prompt.test.ts
git commit -m "feat(agent): compose the profile role into the bridge system prompt"
```

---

### Task 3: `AgentRunOptions.rolePrompt`

**Files:**
- Modify: `src/agent/types.ts:57-82`

- [ ] **Step 1: Add the field**

In `src/agent/types.ts`, add to `AgentRunOptions` (after `permissionMode`, before `stopGraceMs`):

```ts
  /**
   * Per-profile role (system-prompt soft constraint) from the run policy.
   * Adapters append it via `composeSystemPrompt`; absent/blank means no role.
   */
  rolePrompt?: string;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (the field is optional; nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat(agent): carry rolePrompt on AgentRunOptions"
```

---

### Task 4: run policy exposes `rolePrompt`

**Files:**
- Modify: `src/policy/run-policy.ts:60-72,130-150`
- Test: `tests/unit/policy/run-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('run policy', ...)` in `tests/unit/policy/run-policy.test.ts` (before the closing `});` at line 159):

```ts
  it('carries a trimmed profile role prompt and omits a blank one', () => {
    const withRole = evaluateRunPolicy(
      baseInput({
        profileConfig: { ...profile(), role: { prompt: '  你是财务助手  ' } },
      }),
    );
    expect(withRole).toMatchObject({ ok: true, rolePrompt: '你是财务助手' });

    const blank = evaluateRunPolicy(
      baseInput({ profileConfig: { ...profile(), role: { prompt: '   ' } } }),
    );
    expect(blank.ok).toBe(true);
    if (blank.ok) expect('rolePrompt' in blank).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/policy/run-policy.test.ts -t "carries a trimmed profile role"`
Expected: FAIL — `rolePrompt` is not present on the allow result.

- [ ] **Step 3: Implement**

In `src/policy/run-policy.ts`, add to `RunPolicyAllow` (after `permissionMode`):

```ts
  permissionMode: ClaudePermissionMode;
  /** Profile role (system-prompt soft constraint); omitted when blank. */
  rolePrompt?: string;
```

In `evaluateRunPolicy`, right after `permissionMode` is computed (after the `accessToClaudePermissionMode(...)` call), add:

```ts
  const rolePrompt = input.profileConfig.role?.prompt.trim();
```

and add it to the returned allow object (after `permissionMode,`):

```ts
    accessMode,
    sandbox,
    permissionMode,
    ...(rolePrompt ? { rolePrompt } : {}),
    access: input.access,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/policy/run-policy.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/policy/run-policy.ts tests/unit/policy/run-policy.test.ts
git commit -m "feat(policy): surface the profile role on the run policy"
```

---

### Task 5: run executor forwards `rolePrompt`

**Files:**
- Modify: `src/runtime/run-executor.ts:96-111`
- Test: `tests/unit/runtime/run-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('RunExecutor policy runtime options', ...)` in `tests/unit/runtime/run-executor.test.ts` (before the closing `});` at line 38):

```ts
  it('forwards the policy role prompt into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-role',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-role',
      policy: policy({ rolePrompt: '你是财务助手' }),
    });

    expect(agent.runOptions[0]).toMatchObject({ runId: 'run-role', rolePrompt: '你是财务助手' });

    await collect(execution.subscribe());
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runtime/run-executor.test.ts -t "forwards the policy role prompt"`
Expected: FAIL — `rolePrompt` is not on the options handed to `agent.run`.

- [ ] **Step 3: Implement**

In `src/runtime/run-executor.ts`, add to the `runOptions` object (after `permissionMode`):

```ts
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      rolePrompt: input.policy.rolePrompt,
      stopGraceMs: input.stopGraceMs,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runtime/run-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/run-executor.ts tests/unit/runtime/run-executor.test.ts
git commit -m "feat(runtime): forward rolePrompt to the agent adapter"
```

---

### Task 6: inject the role in all three adapters

**Files:**
- Modify: `src/agent/claude/adapter.ts:8,71`
- Modify: `src/agent/codex/adapter.ts:156`
- Modify: `src/agent/opencode/session-consumer.ts:2,297`
- Test: `tests/process/claude-adapter.test.ts`, `tests/process/codex-adapter.test.ts`, `tests/unit/agent/opencode-session-consumer.test.ts`

- [ ] **Step 1: Write the failing tests**

**(a) Claude** — append inside `describe('ClaudeAdapter process contract', ...)` in `tests/process/claude-adapter.test.ts`:

```ts
  it('appends the profile role to the system prompt file', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-role' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-role',
      prompt: 'hi',
      cwd: fake.dir,
      rolePrompt: '你是财务助手',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.systemPrompt).toContain('## 角色设定');
    expect(record.systemPrompt).toContain('你是财务助手');
  });
```

**(b) Codex** — append inside `describe('CodexAdapter process contract', ...)` in `tests/process/codex-adapter.test.ts`:

```ts
  it('prefixes the profile role into the stdin system prompt', async () => {
    const fake = await createFakeCodex({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-role',
      prompt: 'hello',
      cwd,
      rolePrompt: '你是财务助手',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.stdin).toContain('## 角色设定');
    expect(record.stdin).toContain('你是财务助手');
  });
```

**(c) opencode** — first record the `system` field in the test fake, then add the test.

In `tests/unit/agent/opencode-session-consumer.test.ts`, change the `FakeClientCalls.promptAsync` element type (line 34) to include `system`:

```ts
  promptAsync: Array<{ sessionId: string; prompt: string; system?: string }>;
```

and the fake recorder (lines 58-63) to capture it:

```ts
    async promptAsync(opts) {
      calls.promptAsync.push({
        sessionId: opts.sessionId,
        prompt: opts.parts.map((p) => p.text).join(''),
        system: opts.system,
      });
    },
```

Then append inside `describe('OpencodeSessionConsumer — multi-turn behavior', ...)`:

```ts
  it('injects the profile role into the per-turn system field', async () => {
    const stream = new FakeStream();
    const { client, calls } = makeFakeClient('ses_role');
    const consumer = makeConsumer(stream, client);

    const turn = consumer.dispatchTurn({
      runId: 'r1',
      prompt: 'hi',
      cwd: '/repo',
      rolePrompt: '你是财务助手',
    });
    await waitForSession(consumer);
    stream.push({ kind: 'connected' });
    stream.push({ kind: 'status', sessionID: 'ses_role', status: 'idle' });
    await drain(turn.events);

    expect(calls.promptAsync[0]?.system).toContain('## 角色设定');
    expect(calls.promptAsync[0]?.system).toContain('你是财务助手');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/process/claude-adapter.test.ts tests/process/codex-adapter.test.ts tests/unit/agent/opencode-session-consumer.test.ts`
Expected: FAIL — the role section is missing from the system prompt / stdin / per-turn `system`.

- [ ] **Step 3: Wire the three injection points**

`src/agent/claude/adapter.ts` — swap the import (line 8):

```ts
import { composeSystemPrompt } from '../bridge-system-prompt';
```

and line 71:

```ts
    const systemPromptFile = writeSystemPromptFile(
      composeSystemPrompt(this.botIdentity, opts.rolePrompt),
    );
```

`src/agent/codex/adapter.ts` — line 156 (import of `prefixBridgeSystemPrompt` is unchanged):

```ts
    child.stdin.end(
      prefixBridgeSystemPrompt(opts.prompt, this.botIdentity, opts.rolePrompt),
      'utf8',
    );
```

`src/agent/opencode/session-consumer.ts` — swap the import (line 2):

```ts
import { composeSystemPrompt } from '../bridge-system-prompt';
```

and line 297:

```ts
      const bridgeSystemPrompt = composeSystemPrompt(this.deps.botIdentity, opts.rolePrompt);
```

> opencode v2 needs no change: `buildV2PromptText` already prepends `o.system` into the prompt text (`src/agent/opencode/transport-v2.ts:55`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/process/claude-adapter.test.ts tests/process/codex-adapter.test.ts tests/unit/agent/opencode-session-consumer.test.ts`
Expected: PASS.

Then run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/adapter.ts src/agent/codex/adapter.ts src/agent/opencode/session-consumer.ts tests/process/claude-adapter.test.ts tests/process/codex-adapter.test.ts tests/unit/agent/opencode-session-consumer.test.ts
git commit -m "feat(agent): inject the profile role in claude, codex, and opencode"
```

---

### Task 7: `src/ui/role-api.ts` (view + save)

**Files:**
- Create: `src/ui/role-api.ts`
- Test: `tests/unit/ui/role-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ui/role-api.test.ts`:

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, ROLE_PROMPT_MAX_BYTES, truncateUtf8 } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { buildRoleView, saveRoleConfig } from '../../../src/ui/role-api';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };

async function createState(agentKind: 'claude' | 'codex' = 'claude') {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-role-api-'));
  cleanups.push(rootDir);
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  const configPath = join(rootDir, 'config.json');
  await saveRootConfig(
    createRootConfig(
      'claude',
      createDefaultProfileConfig({
        agentKind,
        accounts: { app },
        ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
      }),
    ),
    configPath,
  );
  const root = (await loadRootConfig(configPath))!;
  const state = {
    configPath,
    profile: 'claude',
    cfg: runtimeProfileConfig(root, 'claude'),
    profileConfig: root.profiles.claude!,
  };
  return { configPath, state };
}

describe('buildRoleView', () => {
  it('reports agent kind, injection mode, and an empty prompt for a fresh profile', async () => {
    const { state } = await createState('claude');
    expect(buildRoleView(state, true)).toMatchObject({
      profile: 'claude',
      agentKind: 'claude',
      prompt: '',
      injection: 'append-system-prompt',
      capabilities: { mcp: 'control', skills: 'readonly' },
      live: true,
    });
  });
});

describe('saveRoleConfig', () => {
  it('trims, persists, and refreshes in-memory state', async () => {
    const { configPath, state } = await createState();

    const view = await saveRoleConfig(state, { prompt: '  你是财务助手  ' }, true);

    expect(view.prompt).toBe('你是财务助手');
    expect(state.profileConfig.role?.prompt).toBe('你是财务助手');
    const disk = (await loadRootConfig(configPath))!;
    expect(disk.profiles.claude!.role?.prompt).toBe('你是财务助手');
  });

  it('removes the role when the prompt is blank', async () => {
    const { configPath, state } = await createState();
    await saveRoleConfig(state, { prompt: '你是助手' });
    expect(state.profileConfig.role).toBeDefined();

    const view = await saveRoleConfig(state, { prompt: '   ' });

    expect(view.prompt).toBe('');
    expect(state.profileConfig.role).toBeUndefined();
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toBeUndefined();
  });

  it('rejects a non-string prompt with a 400', async () => {
    const { state } = await createState();
    await expect(saveRoleConfig(state, { prompt: 42 })).rejects.toMatchObject({ status: 400 });
  });

  it('truncates an over-long prompt at the byte cap', async () => {
    const { state } = await createState();
    const huge = '你'.repeat(ROLE_PROMPT_MAX_BYTES); // 3 bytes each → far over

    const view = await saveRoleConfig(state, { prompt: huge });

    expect(Buffer.byteLength(view.prompt, 'utf8')).toBeLessThanOrEqual(ROLE_PROMPT_MAX_BYTES);
    expect(view.prompt.length).toBeGreaterThan(0);
  });
});

describe('truncateUtf8', () => {
  it('keeps the string when within budget and never splits a code point', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
    const out = truncateUtf8('你你', 4); // one 3-byte char fits, the second does not
    expect(out).toBe('你');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/ui/role-api.test.ts`
Expected: FAIL — `src/ui/role-api.ts` does not exist.

- [ ] **Step 3: Implement `src/ui/role-api.ts`**

```ts
import {
  claudeCapability,
  codexCapability,
  opencodeCapability,
  type AgentCapability,
  type PromptInjectionMode,
} from '../agent/capability';
import type { MutableProfileState } from '../config/config-ops';
import {
  ROLE_PROMPT_MAX_BYTES,
  truncateUtf8,
  type AgentKind,
  type RoleConfig,
} from '../config/profile-schema';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import { HttpError } from './http';

export type RoleScopeCapability = 'control' | 'readonly' | 'none';

export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** How this agent injects the role (from its capability). */
  injection: PromptInjectionMode;
  /** Phase 2: how far MCP / skill scope can be controlled per bridge. */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  live: boolean;
}

/**
 * Per-bridge role scope control level. Phase 2 uses it to decide whether the
 * MCP / skill cards are switchable. Role injection itself works on all three.
 */
const ROLE_SCOPE: Record<AgentKind, { mcp: RoleScopeCapability; skills: RoleScopeCapability }> = {
  claude: { mcp: 'control', skills: 'readonly' },
  codex: { mcp: 'readonly', skills: 'none' },
  opencode: { mcp: 'control', skills: 'control' },
};

function capabilityFor(agentKind: AgentKind, state: MutableProfileState): AgentCapability {
  switch (agentKind) {
    case 'codex':
      return codexCapability(state.profileConfig);
    case 'opencode':
      return opencodeCapability(state.profileConfig);
    default:
      return claudeCapability(state.profileConfig);
  }
}

/** Read the profile's role view (online state is the live `Controls`, offline is disk). */
export function buildRoleView(state: MutableProfileState, live: boolean): RoleView {
  const agentKind = state.profileConfig.agentKind;
  return {
    profile: state.profile,
    agentKind,
    prompt: state.profileConfig.role?.prompt ?? '',
    injection: capabilityFor(agentKind, state).promptInjection,
    capabilities: ROLE_SCOPE[agentKind],
    live,
  };
}

/**
 * Persist the profile's role (under the config file lock) and refresh the
 * in-memory state. `Controls` structurally satisfies `MutableProfileState`, so
 * an online profile picks the change up on its next run without a restart.
 * Writes `prompt`; any existing phase-2 whitelist fields are preserved.
 */
export async function saveRoleConfig(
  state: MutableProfileState,
  body: unknown,
  live = false,
): Promise<RoleView> {
  const role = parseRoleBody(body);
  try {
    await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) throw new Error('config file not found');
      const profile = root.profiles[state.profile];
      if (!profile) throw new HttpError(404, `profile not found: ${state.profile}`);
      const next = { ...profile };
      const existing = profile.role;
      const preserved = existing
        ? {
            ...(existing.mcpEnabled ? { mcpEnabled: existing.mcpEnabled } : {}),
            ...(existing.skillsEnabled ? { skillsEnabled: existing.skillsEnabled } : {}),
          }
        : {};
      const merged: RoleConfig | undefined = role
        ? { ...preserved, prompt: role.prompt }
        : Object.keys(preserved).length > 0
          ? { prompt: '', ...preserved }
          : undefined;
      if (merged) next.role = merged;
      else delete next.role;
      root.profiles[state.profile] = next;
      await saveRootConfig(root, state.configPath);
      state.profileConfig = root.profiles[state.profile]!;
      state.cfg = runtimeProfileConfig(root, state.profile);
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return buildRoleView(state, live);
}

/** Parse `{ prompt }`; a blank prompt clears the role text. */
function parseRoleBody(body: unknown): RoleConfig | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  const raw = body as { prompt?: unknown };
  if (typeof raw.prompt !== 'string') {
    throw new HttpError(400, 'prompt must be a string');
  }
  const prompt = truncateUtf8(raw.prompt.trim(), ROLE_PROMPT_MAX_BYTES);
  return prompt ? { prompt } : undefined;
}
```

> `truncateUtf8` is imported from `../config/profile-schema` (Task 1) — do not define a second copy here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/ui/role-api.test.ts`
Expected: PASS (all tests).

Then run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/role-api.ts tests/unit/ui/role-api.test.ts
git commit -m "feat(ui): role view and save (disk write + live refresh)"
```

---

### Task 8: server routes `GET` / `POST /api/role`

**Files:**
- Modify: `src/ui/server.ts` (imports near line 44-60; routes after the `/api/access` block at line 260-264)
- Test: `tests/integration/ui/server.test.ts` (append to the existing supervisor harness — same online/offline fixtures the routes need)

- [ ] **Step 1: Write the failing tests**

In `tests/integration/ui/server.test.ts`, append inside `describe('ui server (supervisor-backed)', ...)`:

```ts
  it('reads and saves the profile role (live, online profile)', async () => {
    const view = await json(await get('/api/role', handle.token));
    expect(view).toMatchObject({ profile: 'claude', live: true, prompt: '' });
    expect(view.injection).toBe('append-system-prompt');

    const saved = await json(await post('/api/role', handle.token, { prompt: '  你是财务助手  ' }));
    expect(saved.prompt).toBe('你是财务助手');
    // live: the in-memory Controls got the new role
    expect(online.get('claude').profileConfig.role.prompt).toBe('你是财务助手');

    const reread = await json(await get('/api/role', handle.token));
    expect(reread.prompt).toBe('你是财务助手');
  });

  it('saves the role for an offline profile to disk only', async () => {
    const saved = await json(
      await post('/api/role?profile=work', handle.token, { prompt: '你是运维助手' }),
    );
    expect(saved).toMatchObject({ profile: 'work', live: false, prompt: '你是运维助手' });

    const reread = await json(await get('/api/role?profile=work', handle.token));
    expect(reread.prompt).toBe('你是运维助手');

    const disk = (await loadRootConfig(configPath))!;
    expect(disk.profiles.work!.role?.prompt).toBe('你是运维助手');
  });

  it('400s a non-string role prompt', async () => {
    const res = await post('/api/role', handle.token, { prompt: 42 });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/integration/ui/server.test.ts -t "role"`
Expected: FAIL — `/api/role` falls through to 404.

- [ ] **Step 3: Wire the routes**

In `src/ui/server.ts`, add the import next to the other UI-module imports (near the `workspace-api` import, ~line 44):

```ts
import { buildRoleView, saveRoleConfig } from './role-api';
```

Insert immediately after the `POST /api/access` block (after line 264):

```ts
  // --- role (system-prompt soft constraint) ---
  if (path === '/api/role' && g) {
    const { state, live } = await resolveTargetState(deps, url);
    sendJson(res, 200, buildRoleView(state, live));
    return;
  }
  if (path === '/api/role' && p) {
    const { state, live } = await resolveTargetState(deps, url);
    sendJson(res, 200, await saveRoleConfig(state, await readJsonBody(req), live));
    return;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/integration/ui/server.test.ts`
Expected: PASS (all tests).

Then run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/server.ts tests/integration/ui/server.test.ts
git commit -m "feat(ui): route GET/POST /api/role"
```

---

### Task 9: frontend "角色" tab

**Files:**
- Modify: `web/src/lib/types.ts` (after `ConfigView`, ~line 61)
- Create: `web/src/components/ui/textarea.tsx`
- Create: `web/src/views/RoleView.tsx`
- Modify: `web/src/views/ProfileDetail.tsx:17-19,124-135`

- [ ] **Step 1: Add the view types**

In `web/src/lib/types.ts`, after `ConfigView` (line 61), add:

```ts
export type PromptInjectionMode =
  | "append-system-prompt"
  | "stdin-prefix"
  | "prompt-body-system";

export type RoleScopeCapability = "control" | "readonly" | "none";

/** Per-profile role (system-prompt soft constraint). */
export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** How this agent injects the role. */
  injection: PromptInjectionMode;
  /** Phase 2: how far MCP / skill scope can be controlled. */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  /** True when this profile's process hosts the UI (edits apply live). */
  live: boolean;
}
```

- [ ] **Step 2: Add a local `Textarea` (no new dependency)**

Create `web/src/components/ui/textarea.tsx`:

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-[140px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 3: Create the role page**

Create `web/src/views/RoleView.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { RoleView as RoleViewModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";

const INJECTION_LABEL: Record<string, string> = {
  "append-system-prompt": "追加系统提示文件",
  "stdin-prefix": "前缀进标准输入",
  "prompt-body-system": "每轮 system 字段",
};

export function RoleView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<RoleViewModel | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<RoleViewModel>(`/api/role?${q}`)
      .then((v) => {
        setView(v);
        setPrompt(v.prompt);
        setError(null);
      })
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, [q]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const v = await apiPost<RoleViewModel>(`/api/role?${q}`, { prompt });
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
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Add the tab to the profile detail page**

In `web/src/views/ProfileDetail.tsx`, add the import next to `WorkspaceView` (line 19):

```tsx
import { WorkspaceView } from "./WorkspaceView";
import { RoleView } from "./RoleView";
```

Add the trigger (after the `workspace` trigger, line 127):

```tsx
          <TabsTrigger value="workspace">工作空间</TabsTrigger>
          <TabsTrigger value="role">角色</TabsTrigger>
```

Add the content (after the `workspace` content, line 134):

```tsx
        <TabsContent value="workspace" className="mt-4">
          <WorkspaceView profile={profile} />
        </TabsContent>
        <TabsContent value="role" className="mt-4">
          <RoleView profile={profile} />
        </TabsContent>
```

- [ ] **Step 5: Typecheck and build the web bundle**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json && pnpm build:web`
Expected: PASS; `src/ui/generated/index.html` rebuilt (gitignored).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/types.ts web/src/components/ui/textarea.tsx web/src/views/RoleView.tsx web/src/views/ProfileDetail.tsx
git commit -m "feat(web): role tab in the profile detail page"
```

---

### Task 10: docs

**Files:**
- Modify: `README.zh.md:307-309` (after the workspace section, before `## 权限模式`)
- Modify: `README.md:307-309`

- [ ] **Step 1: Chinese README**

In `README.zh.md`, after line 307 (the trailing workspace bullet) and before `## 权限模式`, insert:

```md
### 控制台：角色

profile 详情页的「角色」页用于给该 profile 写一段**角色设定**。它本质是该 profile 的系统提示词软限制：作为 `## 角色设定` 段追加在 bridge 运行约定之后，注入该 profile 的每一次运行（claude 走 `--append-system-prompt-file`、codex 前缀进 stdin、opencode v1 每轮 `system` / v2 前置进文本）。

- 它是提示词层的约束（身份、语气、边界），**不是硬权限**；真正的权限在「配置」页的访问控制里。
- 在线 profile 保存后**下一轮运行即生效**；离线 profile 保存后**下次启动生效**。
- 空内容保存即清除角色。
```

- [ ] **Step 2: English README**

In `README.md`, after line 307 and before `## Permission modes`, insert:

```md
### Console: role

The profile detail page's **Role** tab lets you write a **role** for that profile. It is a system-prompt soft constraint: appended as a `## 角色设定` section after the bridge run conventions and injected into every run for that profile (claude via `--append-system-prompt-file`, codex as a stdin prefix, opencode v1 as the per-turn `system` / v2 prepended into the text).

- It constrains identity, tone, and boundaries at the prompt layer. It is **not a hard permission** — real permissions live in the **Configuration** tab's access control.
- An online profile takes effect on the **next run** after saving; an offline profile takes effect on its **next start**.
- Saving an empty prompt clears the role.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: document the console role tab"
```

---

### Task 11: full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the focused suites**

Run: `pnpm exec vitest run tests/unit/config/role-schema.test.ts tests/unit/ui/role-api.test.ts tests/unit/agent/bridge-system-prompt.test.ts tests/unit/policy/run-policy.test.ts tests/unit/runtime/run-executor.test.ts tests/unit/agent/opencode-session-consumer.test.ts tests/process/claude-adapter.test.ts tests/process/codex-adapter.test.ts tests/integration/ui/server.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the broader config/policy/agent/ui suites**

Run: `pnpm exec vitest run tests/unit/config tests/unit/policy tests/unit/runtime tests/unit/agent tests/integration/ui`
Expected: PASS.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (web bundle + tsup output).

- [ ] **Step 4: Grep for leftovers**

Run: `rg -n "buildBridgeSystemPrompt" src`
Expected: only `src/agent/bridge-system-prompt.ts` (its own definition) and its test — the three adapters now use `composeSystemPrompt`.

- [ ] **Step 5: Confirm the tree is clean**

Run: `git status --short`
Expected: no tracked files changed (`pnpm build` writes only gitignored output under `src/ui/generated/`).

---

## Notes for the implementer

- **The storage whitelist is the trap.** `src/config/profile-store.ts` serializes profiles through a fixed `StoredProfileConfig` shape; a new `role` field is dropped on `saveRootConfig` unless it is added to both `StoredProfileConfig` and `serializeProfileConfig` (Task 1 Step 4). The round-trip test in Task 1 fails loudly if you forget.
- **One composition point.** All three adapters use `composeSystemPrompt`; do not inline role concatenation per adapter. `prefixBridgeSystemPrompt` keeps its 2-arg signature working via the optional third parameter.
- **`rolePrompt` is intentionally optional** end-to-end. An empty/blank role must produce a result with no `rolePrompt` key, so downstream `toMatchObject`/fingerprint behavior is unchanged.
- **Live-vs-disk** matches `savePreferencesConfig`: online profiles are `Controls` objects (which structurally satisfy `MutableProfileState`) and are refreshed in place; offline profiles only touch disk and take effect on the next start.
- **Phase-1 boundary:** `saveRoleConfig` writes `prompt` and preserves any existing `mcpEnabled` / `skillsEnabled` whitelists (a blank prompt clears the role text but keeps whitelists; the whole `role` is deleted only when nothing remains). Phase 1's UI never sets the whitelists; phase 2 adds the catalog + UI and extends `parseRoleBody` to accept them. `RoleView.capabilities` is already emitted so phase 2 is additive.
- **`pnpm test` (whole suite) has known environment/load flakiness on this machine** (missing `sh`, timeouts under load); the focused suites above plus `pnpm typecheck && pnpm build` are the gate.
