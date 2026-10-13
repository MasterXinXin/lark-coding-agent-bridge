# Project Branch Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the console's per-project branch field into a repo-branch dropdown that immediately switches the checkout, persists the branch, re-syncs the codegraph index, and makes scheduled/manual pulls follow the configured branch.

**Architecture:** Add `git ls-remote`/`checkout` helpers in `git-ops.ts`; add `projectBranchesView` + `switchProjectBranch` in `workspace-api.ts` (a new `branch` background job); extend the rollback/ledger to undo a half-done switch; make `pullProjects` align the checkout to the configured branch before pulling; and drive it all from a Radix `Select` in `WorkspaceView.tsx`.

**Tech Stack:** TypeScript, Node `child_process`, Fastify-free raw `node:http` UI server, React + Vite + Radix UI, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-13-project-branch-switch-design.md`

**Worktree:** work in-place on `main` in `D:\code\lark-coding-agent-bridge`.

---

### Task 1: git-ops branch helpers

**Files:**
- Modify: `src/git/git-ops.ts` (append after `currentBranch`, before `normalizeRemote`)
- Test: `tests/unit/git/git-ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/git/git-ops.test.ts` — first extend the import:

```ts
import {
  currentBranch,
  ensureCheckout,
  isGitRepo,
  listLocalBranches,
  listRemoteBranches,
  normalizeRemote,
  pullRepo,
  remoteUrl,
  repoStatus,
  switchBranch,
  type GitResult,
  type GitRunner,
} from '../../../src/git/git-ops';
```

Then append this block at the end of the file:

```ts
describe('git-ops branch helpers', () => {
  it('parses remote heads from ls-remote', async () => {
    const sha = 'a'.repeat(40);
    const run = fakeRunner({
      'ls-remote --heads -- https://x/y.git': {
        stdout: `${sha}\trefs/heads/main\n${sha}\trefs/heads/release\n`,
      },
    });
    expect(await listRemoteBranches(run, 'https://x/y.git')).toEqual(['main', 'release']);
  });

  it('throws a short detail when ls-remote fails', async () => {
    const run = fakeRunner({
      'ls-remote --heads -- https://x/y.git': { code: 128, stderr: 'fatal: could not read\n' },
    });
    await expect(listRemoteBranches(run, 'https://x/y.git')).rejects.toThrow(/git ls-remote 失败/);
  });

  it('lists local branches and degrades to empty for a non-repo', async () => {
    const run = fakeRunner({
      'branch --format=%(refname:short)': { stdout: 'main\nrelease\n\n' },
    });
    expect(await listLocalBranches(run, '/repo')).toEqual(['main', 'release']);
    expect(await listLocalBranches(fakeRunner({}), '/repo')).toEqual([]);
  });

  it('fetches then checks out the target branch', async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    await switchBranch(run, '/repo', 'release');
    expect(calls).toEqual([['fetch', '--prune', '--progress'], ['checkout', 'release']]);
  });

  it('throws after a failed checkout without hiding the git detail', async () => {
    const run: GitRunner = async (args) =>
      args[0] === 'checkout'
        ? { code: 1, stdout: '', stderr: "error: pathspec 'x' did not match\n" }
        : { code: 0, stdout: '', stderr: '' };
    await expect(switchBranch(run, '/repo', 'x')).rejects.toThrow(/git checkout 失败/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/git/git-ops.test.ts`
Expected: FAIL — `listLocalBranches`, `listRemoteBranches`, `switchBranch` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/git/git-ops.ts`, immediately after the `currentBranch` function (ends at line 92, right before `normalizeRemote`), add:

```ts
/**
 * Remote branch names via `git ls-remote --heads <repoUrl>`. Throws on failure
 * (network/permission) so the caller can degrade to free-text input.
 */
export async function listRemoteBranches(
  run: GitRunner,
  repoUrl: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const r = await run(['ls-remote', '--heads', '--', repoUrl], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(`git ls-remote 失败：${failureDetail(r)}`);
  const names: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/** Local branch names; a non-repo/missing dir degrades to an empty list. */
export async function listLocalBranches(run: GitRunner, dir: string): Promise<string[]> {
  const r = await run(['branch', '--format=%(refname:short)'], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `fetch --prune` then `checkout <branch>`; throws with a short git detail. */
export async function switchBranch(
  run: GitRunner,
  dir: string,
  branch: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const fetch = await run(['fetch', '--prune', '--progress'], {
    cwd: dir,
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: 120_000,
  });
  if (fetch.code !== 0) throw new Error(`git fetch 失败：${failureDetail(fetch)}`);
  const checkout = await run(['checkout', branch], {
    cwd: dir,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (checkout.code !== 0) throw new Error(`git checkout 失败：${failureDetail(checkout)}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/git/git-ops.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/git/git-ops.ts tests/unit/git/git-ops.test.ts
git commit -m "feat(git): add branch list/switch helpers"
```

---

### Task 2: rollback + ledger `branch-switch`

**Files:**
- Modify: `src/workspace/operation-context.ts:12-23`
- Modify: `src/workspace/rollback.ts:1-95`
- Modify: `src/workspace/ledger.ts:141-166`
- Test: `tests/unit/workspace/rollback.test.ts`, `tests/unit/workspace/ledger.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/workspace/rollback.test.ts`, append inside `describe('executeRollback', ...)` (after the `codegraph-sync` test):

```ts
  it('switches back to the previous branch on cancel', async () => {
    const dir = join(workspaceDir, 'proj');
    await mkdir(dir, { recursive: true });
    const switchBack = vi.fn(async () => {});

    await executeRollback({ kind: 'branch-switch', dir, previousBranch: 'main' }, { switchBack });

    expect(switchBack).toHaveBeenCalledWith(dir, 'main');
  });

  it('does nothing for a branch-switch with no previous branch', async () => {
    const dir = join(workspaceDir, 'proj');
    const switchBack = vi.fn(async () => {});

    await executeRollback({ kind: 'branch-switch', dir, previousBranch: '' }, { switchBack });

    expect(switchBack).not.toHaveBeenCalled();
  });
```

In `tests/unit/workspace/ledger.test.ts`, add `normalizeRollback` to the import from `'../../../src/workspace/ledger'` (lines 5-13) and append inside `describe('ledger', ...)`:

```ts
  it('normalizes a branch-switch rollback and rejects an incomplete one', () => {
    expect(
      normalizeRollback({ kind: 'branch-switch', dir: '/ws/x', previousBranch: 'main' }),
    ).toEqual({ kind: 'branch-switch', dir: '/ws/x', previousBranch: 'main' });
    expect(normalizeRollback({ kind: 'branch-switch', dir: '/ws/x' })).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/workspace/rollback.test.ts tests/unit/workspace/ledger.test.ts`
Expected: FAIL — `branch-switch` is not a member of `RollbackDescriptor` (type error) and `normalizeRollback` throws / returns `undefined` for the valid case.

- [ ] **Step 3: Add the descriptor**

In `src/workspace/operation-context.ts`, extend the union (line 22-23):

```ts
  | { kind: 'codegraph-init'; dir: string }
  | { kind: 'codegraph-sync'; dir: string }
  | { kind: 'branch-switch'; dir: string; previousBranch: string };
```

- [ ] **Step 4: Handle it in rollback**

In `src/workspace/rollback.ts`, add the import at the top (after `import { log } ...`):

```ts
import { createGitRunner } from '../git/git-ops';
```

Add to `RollbackDeps`:

```ts
  /** Best-effort `git checkout` back to a branch; injectable for tests. */
  switchBack?: (dir: string, branch: string) => Promise<void>;
```

Insert this branch in `executeRollback` right before the `const unlock = ...` tail (i.e. before the codegraph-sync fallthrough):

```ts
  if (descriptor.kind === 'branch-switch') {
    if (!descriptor.previousBranch) return;
    const switchBack = deps.switchBack ?? defaultSwitchBack;
    await switchBack(descriptor.dir, descriptor.previousBranch).catch((err) =>
      log.warn('workspace', 'rollback-branch-switch-failed', {
        dir: descriptor.dir,
        branch: descriptor.previousBranch,
        err: String(err),
      }),
    );
    return;
  }
```

Append near `defaultUnlock`:

```ts
/** Best-effort `git checkout` that undoes a cancelled branch switch. */
async function defaultSwitchBack(dir: string, branch: string): Promise<void> {
  const runner = createGitRunner();
  const r = await runner(['checkout', branch], { cwd: dir });
  if (r.code !== 0) throw new Error('git checkout 失败');
}
```

- [ ] **Step 5: Normalize it in the ledger**

In `src/workspace/ledger.ts`, inside `normalizeRollback`, add before the `add-checkout` case:

```ts
  if (r.kind === 'branch-switch' && typeof r.previousBranch === 'string') {
    return { kind: 'branch-switch', dir, previousBranch: r.previousBranch };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/workspace/rollback.test.ts tests/unit/workspace/ledger.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workspace/operation-context.ts src/workspace/rollback.ts src/workspace/ledger.ts tests/unit/workspace/rollback.test.ts tests/unit/workspace/ledger.test.ts
git commit -m "feat(workspace): roll back a cancelled branch switch"
```

---

### Task 3: `projectBranchesView` + branch listing test scaffold

**Files:**
- Modify: `src/ui/workspace-api.ts` (imports; add view after `resolveProjectDir`)
- Create: `tests/integration/workspace/branch-switch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/workspace/branch-switch.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import type { GitRunner } from '../../../src/git/git-ops';
import {
  addProjects,
  projectBranchesView,
  projectsView,
  pullProjects,
  setSchedule,
  switchProjectBranch,
} from '../../../src/ui/workspace-api';
import {
  ensureCodegraphExcluded,
  type CodegraphHook,
  type CodegraphOpResult,
} from '../../../src/workspace/codegraph';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-branch-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig(
    'claude',
    createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
  );
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Real local bare origin with one commit on `main` plus a `release` branch. */
async function makeOrigin(base: string): Promise<string> {
  const origin = join(base, 'origin.git');
  git(base, ['init', '--bare', origin]);
  const seed = join(base, 'seed');
  git(base, ['clone', origin, seed]);
  git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['branch', 'release']);
  git(seed, ['push', '-u', 'origin', 'main', 'release']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return origin;
}

function syncHook(available = true): { hook: CodegraphHook; syncDirs: string[] } {
  const syncDirs: string[] = [];
  const ok: CodegraphOpResult = { ok: true };
  const hook: CodegraphHook = {
    available,
    init: async () => ok,
    sync: async (dir) => {
      syncDirs.push(dir);
      return ok;
    },
    installCli: async () => ok,
    wireMcp: async () => ok,
  };
  return { hook, syncDirs };
}

describe('project branch switch', { timeout: 60_000 }, () => {
  it('lists branches with the current branch first', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const [entry] = (await projectsView('claude', rootDir)).projects;

    const view = await projectBranchesView('claude', rootDir, entry!.id);

    expect(view.current).toBe('main');
    expect(view.branches[0]).toBe('main');
    expect(view.branches).toEqual(expect.arrayContaining(['main', 'release']));
  });

  it('404s branch listing for an unknown project', async () => {
    await expect(projectBranchesView('claude', rootDir, 'ghost')).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces an ls-remote failure as a 400 HttpError', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;
    const failing: GitRunner = async (args) =>
      args[0] === 'ls-remote'
        ? { code: 128, stdout: '', stderr: 'fatal: nope\n' }
        : { code: 0, stdout: '', stderr: '' };

    await expect(projectBranchesView('claude', rootDir, id, failing)).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts`
Expected: FAIL — `projectBranchesView` is not exported.

- [ ] **Step 3: Implement `projectBranchesView`**

In `src/ui/workspace-api.ts`, extend the git-ops import (lines 9-17) to:

```ts
import {
  createGitRunner,
  currentBranch,
  ensureCheckout,
  isGitRepo,
  listLocalBranches,
  listRemoteBranches,
  repoStatus,
  pullRepo,
  type GitRunner,
  type RepoStatus,
} from '../git/git-ops';
```

(`switchBranch`, `PullOutcome` and `PullStrategy` are added in Task 5 where they are first used.)

Add this after `resolveProjectDir` (line 132, before `projectsView`):

```ts
export interface ProjectBranchesView {
  branches: string[];
  current?: string;
}

/**
 * List a project's branches from the repo itself (remote heads ∪ local
 * branches), without requiring an account/provider. The checked-out branch
 * (or the configured one when not checked out) is listed first.
 */
export async function projectBranchesView(
  profile: string,
  rootDir: string | undefined,
  id: string,
  runner: GitRunner = run,
): Promise<ProjectBranchesView> {
  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const entry = store.get(id);
  if (!entry) throw new HttpError(404, `项目不存在：${id}`);
  const dir = resolveProjectDir(workspaceDir, entry.localPath);
  const usernames = await accountUsernames(rootDir);
  const env = entry.accountId
    ? await gitEnvForAccount(entry.accountId, hostStorePaths(rootDir), usernames.get(entry.accountId))
    : undefined;

  let remote: string[];
  try {
    remote = await listRemoteBranches(runner, entry.repoUrl, {
      cwd: workspaceDir,
      ...(env ? { env } : {}),
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }

  const exists = await isGitRepo(runner, dir).catch(() => false);
  const local = exists ? await listLocalBranches(runner, dir) : [];
  const current = (exists ? await currentBranch(runner, dir) : undefined) ?? (entry.branch || undefined);

  const set = new Set<string>();
  for (const name of [...remote, ...local, current, entry.branch]) {
    if (name) set.add(name);
  }
  const branches = [...set].sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
  return { branches, ...(current ? { current } : {}) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/workspace-api.ts tests/integration/workspace/branch-switch.test.ts
git commit -m "feat(workspace): list a project's repo branches"
```

---

### Task 4: `switchProjectBranch` (replaces `updateProjectBranch`)

**Files:**
- Modify: `src/ui/workspace-api.ts:310-327`
- Test: `tests/integration/workspace/branch-switch.test.ts`, `tests/integration/ui/workspace-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `describe('project branch switch', ...)` in `tests/integration/workspace/branch-switch.test.ts`:

```ts
  it('switches the checkout, persists the branch, and syncs the index', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    // A raw `.codegraph/` is untracked and would make the tree look dirty.
    await ensureCodegraphExcluded(join(workspace, 'x'));
    const { hook, syncDirs } = syncHook();
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await switchProjectBranch('claude', rootDir, { id, branch: 'release' }, undefined, undefined, hook);

    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.branch).toBe('release');
    expect(view.projects[0]!.status.branch).toBe('release');
    expect(syncDirs).toEqual([join(workspace, 'x')]);
  });

  it('refuses to switch when the tree is dirty and keeps the branch', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await writeFile(join(workspace, 'x', 'wip.txt'), 'wip', 'utf8');
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await expect(
      switchProjectBranch('claude', rootDir, { id, branch: 'release' }),
    ).rejects.toThrow(/未提交改动/);

    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.branch).toBe('main');
    expect(view.projects[0]!.status.branch).toBe('main');
  });

  it('is a no-op when the target already matches the current branch', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    const { hook, syncDirs } = syncHook();
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await switchProjectBranch('claude', rootDir, { id, branch: 'main' }, undefined, undefined, hook);

    expect(syncDirs).toEqual([]);
  });
```

Update `tests/integration/ui/workspace-api.test.ts`: replace `updateProjectBranch` in the import list (line 22) with `switchProjectBranch`, and replace the `'updates branch, sets workspace, and removes'` test (lines 128-138) with:

```ts
  it('switches branch, sets workspace, and removes', async () => {
    const origin = await makeOrigin(rootDir);
    const seed = join(rootDir, 'seed');
    git(seed, ['branch', 'release']);
    git(seed, ['push', 'origin', 'release']);
    const added = await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = added.projects[0]!.id;

    await switchProjectBranch('claude', rootDir, { id, branch: 'release' });
    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.branch).toBe('release');
    expect(view.projects[0]!.status.branch).toBe('release');

    await setWorkspaceDir('claude', rootDir, { path: workspace });
    await removeProject('claude', rootDir, { id });
    expect((await projectsView('claude', rootDir)).projects).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts tests/integration/ui/workspace-api.test.ts`
Expected: FAIL — `switchProjectBranch` is not exported.

- [ ] **Step 3: Implement `switchProjectBranch`**

In `src/ui/workspace-api.ts`, add this right after the existing `updateProjectBranch` function (keep `updateProjectBranch` for now: `server.ts` still imports it, and Task 7 removes both once the route is rewired):

```ts
/**
 * Switch a project's checkout to `body.branch` and persist it. Refuses a dirty
 * tree, registers a rollback to the previous branch, and re-syncs the codegraph
 * index when the CLI is available and the project is indexed.
 */
export async function switchProjectBranch(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
  codegraph?: CodegraphHook,
): Promise<ProjectsView> {
  const raw = body as { branch?: unknown };
  const branch = typeof raw?.branch === 'string' ? raw.branch.trim() : '';
  if (!branch) throw new HttpError(400, 'branch is required');
  const id = readId(body);

  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const entry = store.get(id);
  if (!entry) throw new HttpError(404, `项目不存在：${id}`);
  const dir = resolveProjectDir(workspaceDir, entry.localPath);
  const usernames = await accountUsernames(rootDir);
  const env = entry.accountId
    ? await gitEnvForAccount(entry.accountId, hostStorePaths(rootDir), usernames.get(entry.accountId))
    : undefined;
  const projectRun = env ? withGitEnv(runner, env) : runner;

  if (!(await isGitRepo(projectRun, dir).catch(() => false))) {
    throw new HttpError(400, '目录不存在或不是 git 仓库，请先完成检出');
  }
  const status = await repoStatus(projectRun, dir);
  const current = status.branch;

  if (current === branch) {
    if (entry.branch !== branch) await persistBranch(profile, rootDir, id, branch);
    return projectsView(profile, rootDir);
  }
  if (status.dirty) throw new HttpError(400, '工作区有未提交改动，已取消切换');

  onStep?.({ id, name: entry.name });
  const op = currentOperation();
  const rollbackKey = `branch-switch:${id}`;
  op?.registerRollback(rollbackKey, { kind: 'branch-switch', dir, previousBranch: current ?? '' });
  await switchBranch(projectRun, dir, branch);
  op?.commitRollback(rollbackKey);

  await persistBranch(profile, rootDir, id, branch);

  if (codegraph?.available && (await projectIndexInfo(dir)).indexed) {
    try {
      const synced = await codegraph.sync(dir);
      if (!synced.ok) log.warn('workspace', 'codegraph-sync-failed', { id, detail: synced.detail });
    } catch (err) {
      log.warn('workspace', 'codegraph-sync-failed', { id, err: String(err) });
    }
  }
  return projectsView(profile, rootDir);
}

/** Persist just the tracked branch name, serialized behind the projects lock. */
async function persistBranch(
  profile: string,
  rootDir: string | undefined,
  id: string,
  branch: string,
): Promise<void> {
  await withProjectStore(profile, rootDir, async (store) => {
    try {
      store.updateBranch(id, branch);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    await store.flush();
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts tests/integration/ui/workspace-api.test.ts`
Expected: PASS.

Then run: `pnpm typecheck`
Expected: PASS (`updateProjectBranch` still exists and is still imported by `server.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/ui/workspace-api.ts tests/integration/workspace/branch-switch.test.ts tests/integration/ui/workspace-api.test.ts
git commit -m "feat(workspace): switch a project's branch on demand"
```

---

### Task 5: pulls follow the configured branch

**Files:**
- Modify: `src/ui/workspace-api.ts:381-412` (the pull loop `else` branch)
- Test: `tests/integration/workspace/branch-switch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `describe('project branch switch', ...)`:

```ts
  it('follows the configured branch on pull, but not under fetch-only', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;
    // Drift: the checkout is on `release` while the config says `main`.
    git(join(workspace, 'x'), ['checkout', '-q', 'release']);

    // fetch-only must not move the working tree.
    await setSchedule('claude', rootDir, { strategy: 'fetch-only' });
    await pullProjects('claude', rootDir, { id });
    expect((await projectsView('claude', rootDir)).projects[0]!.status.branch).toBe('release');

    // ff-only switches back to the configured branch before pulling.
    await setSchedule('claude', rootDir, { strategy: 'ff-only' });
    await pullProjects('claude', rootDir, { id });
    expect((await projectsView('claude', rootDir)).projects[0]!.status.branch).toBe('main');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts -t "follows the configured branch"`
Expected: FAIL — the `ff-only` assertion still sees `release`.

- [ ] **Step 3: Implement the alignment helper and wire it into the loop**

First extend the git-ops import in `src/ui/workspace-api.ts` with `switchBranch` and the two types:

```ts
  switchBranch,
  // …and in the type-only tail:
  type PullOutcome,
  type PullStrategy,
```

Add this helper just above `pullProjects` (line ~349):

```ts
/**
 * When the configured branch drifted from the checkout (e.g. a manual `git
 * checkout`), move the tree back before pulling. A dirty tree can't be moved
 * safely, so the pull is skipped instead. `fetch-only` never touches the tree.
 */
async function alignBranchBeforePull(
  projectRun: GitRunner,
  dir: string,
  branch: string,
  strategy: PullStrategy,
): Promise<PullOutcome | undefined> {
  if (strategy === 'fetch-only') return undefined;
  const status = await repoStatus(projectRun, dir).catch(() => undefined);
  if (!status?.branch || status.branch === branch) return undefined;
  if (status.dirty) return { status: 'skipped', detail: `有未提交改动，无法切换到 ${branch}` };
  await switchBranch(projectRun, dir, branch);
  return undefined;
}
```

Replace the `else { ... }` body in the pull loop (currently lines 381-412) with:

```ts
      } else {
        const drift = await alignBranchBeforePull(projectRun, dir, project.branch, schedule.strategy);
        if (drift) {
          result = drift.status;
          detail = drift.detail;
        } else {
          if ((await projectIndexInfo(dir)).indexed) {
            // A legacy index leaves `.codegraph/` untracked and blocks ff-only
            // pulls; exclude it locally so the repo is clean again.
            await ensureCodegraphExcluded(dir).catch(() => undefined);
          }
          const outcome = await pullRepo(projectRun, dir, schedule.strategy);
          result = outcome.status;
          detail = outcome.detail;
          if (outcome.status === 'updated' && codegraph?.available) {
            // Only a real update needs re-indexing; "up-to-date"/"skipped" do not.
            // A sync failure must not downgrade a successful pull, so swallow+log.
            try {
              if ((await projectIndexInfo(dir)).indexed) {
                const synced = await codegraph.sync(dir);
                if (!synced.ok) {
                  log.warn('workspace', 'codegraph-sync-failed', {
                    id: project.id,
                    detail: synced.detail,
                  });
                }
              } else {
                log.info('workspace', 'codegraph-sync-skipped', {
                  id: project.id,
                  reason: 'not-indexed',
                });
              }
            } catch (err) {
              log.warn('workspace', 'codegraph-sync-failed', { id: project.id, err: String(err) });
            }
          }
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/integration/workspace/branch-switch.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/workspace-api.ts tests/integration/workspace/branch-switch.test.ts
git commit -m "feat(workspace): make pulls follow the configured branch"
```

---

### Task 6: `startBranchJob` background job

**Files:**
- Modify: `src/workspace/git-jobs.ts`
- Test: `tests/integration/workspace/git-jobs.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/integration/workspace/git-jobs.test.ts`, extend the git-jobs import (line 9):

```ts
import { startAddJob, startBranchJob, startCodegraphJob, startPullJob } from '../../../src/workspace/git-jobs';
```

Append inside `describe('git jobs', ...)`:

```ts
  it('runs a branch switch job and reports the new branch', async () => {
    const origin = await makeOrigin(rootDir);
    const seed = join(rootDir, 'seed');
    git(seed, ['branch', 'release']);
    git(seed, ['push', 'origin', 'release']);
    const added = await addProjects(
      'claude',
      rootDir,
      { projects: [{ repoUrl: origin, name: 'x' }] },
      makeRecording([]),
    );
    const id = added.projects[0]!.id;

    const registry = new JobRegistry();
    const job = startBranchJob('claude', rootDir, { id, branch: 'release' }, {
      registry,
      runner: makeRecording([]),
    });
    expect(registry.get(job.id)!.label).toBe('切换分支：release');

    const snap = await waitForJob(registry, job.id);
    expect(snap.status).toBe('succeeded');
    expect(snap.kind).toBe('branch');
    expect(snap.steps.map((s) => s.name)).toEqual(['x']);
    const result = snap.result as ProjectsView;
    expect(result.projects[0]!.branch).toBe('release');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/integration/workspace/git-jobs.test.ts -t "branch switch job"`
Expected: FAIL — `startBranchJob` is not exported.

- [ ] **Step 3: Implement `startBranchJob`**

In `src/workspace/git-jobs.ts`, extend the workspace-api import (line 4):

```ts
import { addProjects, listProjectTargets, pullProjects, switchProjectBranch } from '../ui/workspace-api';
```

Add `'branch'` to `WorkspaceJobKind`:

```ts
  | 'add'
  | 'pull'
  | 'branch'
  | 'codegraph'
```

Add after `startPullJob` (line 187):

```ts
/** `切换分支：<branch>` label. */
function branchLabel(body: unknown): string {
  const branch = (body as { branch?: unknown })?.branch;
  return typeof branch === 'string' && branch.trim() ? `切换分支：${branch.trim()}` : '切换分支';
}

/** Start a background `切换分支` job; resolves with the job id at once. */
export function startBranchJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  return beginJob(
    'branch',
    branchLabel(body),
    { profile, rootDir },
    deps,
    (runner, onStep, codegraph) =>
      switchProjectBranch(profile, rootDir, body, runner, onStep, codegraph),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/integration/workspace/git-jobs.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/workspace/git-jobs.ts tests/integration/workspace/git-jobs.test.ts
git commit -m "feat(workspace): add a background branch-switch job"
```

---

### Task 7: server routes

**Files:**
- Modify: `src/ui/server.ts:44-60,344-349`
- Test: `tests/integration/ui/workspace-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('workspace routes', ...)` in `tests/integration/ui/workspace-routes.test.ts`:

```ts
  it('lists a project branches and switches via a job', async () => {
    const origin = await makeOrigin(rootDir);
    const seed = join(rootDir, 'seed');
    git(seed, ['branch', 'release']);
    git(seed, ['push', 'origin', 'release']);

    const created = await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] });
    const { jobId: addJob } = await json(created);
    expect((await waitForJob(addJob)).status).toBe('succeeded');
    const id = (await json(await get('/api/projects'))).projects[0].id;

    const listed = await get(`/api/projects/branches?id=${id}`);
    expect(listed.status).toBe(200);
    const body = await json(listed);
    expect(body.current).toBe('main');
    expect(body.branches).toEqual(expect.arrayContaining(['main', 'release']));

    const switched = await post('/api/projects/branch', { id, branch: 'release' });
    expect(switched.status).toBe(202);
    const { jobId } = await json(switched);
    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');
    expect(snap.kind).toBe('branch');
  });

  it('400s a branch listing without an id', async () => {
    const res = await get('/api/projects/branches');
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/integration/ui/workspace-routes.test.ts -t "branches"`
Expected: FAIL — `/api/projects/branches` is not routed (falls through to 404) and `POST /api/projects/branch` still returns 200.

- [ ] **Step 3: Wire the routes**

First, delete the now-unused `updateProjectBranch` function from `src/ui/workspace-api.ts` (the block that does `withProjectStore` → `store.updateBranch` → `projectsView`).

In `src/ui/server.ts`, update the workspace-api import (lines 44-52) — drop `updateProjectBranch` and add `projectBranchesView`:

```ts
import {
  projectBranchesView,
  projectsView,
  readPullHistory,
  removeProject,
  setSchedule,
  getSchedule,
  setWorkspaceDir,
} from './workspace-api';
```

Update the git-jobs import (lines 54-60) to include `startBranchJob`:

```ts
import {
  jobRegistry,
  startAddJob,
  startBranchJob,
  startCodegraphJob,
  startPullJob,
  type StartJobDeps,
} from '../workspace/git-jobs';
```

Add the listing route immediately after the `POST /api/projects` route (after line 337):

```ts
  if (path === '/api/projects/branches' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const id = url.searchParams.get('id') ?? '';
    if (!id) throw new HttpError(400, 'id is required');
    sendJson(res, 200, await projectBranchesView(profile, deps.rootDir, id));
    return;
  }
```

Replace the `POST /api/projects/branch` route (lines 344-349) so it starts a job:

```ts
  if (path === '/api/projects/branch' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startBranchJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/integration/ui/workspace-routes.test.ts`
Expected: PASS (all tests).

Then run: `pnpm typecheck`
Expected: PASS (the `updateProjectBranch` import is gone).

- [ ] **Step 5: Commit**

```bash
git add src/ui/server.ts src/ui/workspace-api.ts tests/integration/ui/workspace-routes.test.ts
git commit -m "feat(ui): route project branch listing and switching"
```

---

### Task 8: frontend branch dropdown

**Files:**
- Modify: `web/src/lib/types.ts` (near `ProjectView`, line ~191)
- Modify: `web/src/views/WorkspaceView.tsx`
- Modify: `web/src/components/JobProgressDialog.tsx` (`kindLabel`)

- [ ] **Step 1: Add the view type**

In `web/src/lib/types.ts`, after the `ProjectsView` interface (line 197), add:

```ts
export interface ProjectBranchesView {
  branches: string[];
  current?: string;
}
```

- [ ] **Step 2: Label the branch job**

In `web/src/components/JobProgressDialog.tsx`, add to `kindLabel` (before the `codegraph` cases):

```ts
  if (kind === "branch") return "切换分支";
```

- [ ] **Step 3: Make the branch field a dropdown**

In `web/src/views/WorkspaceView.tsx`:

Add `Select` to the UI imports (after the `Input` import on line 19):

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

Add `ProjectBranchesView` to the type import (lines 3-16):

```tsx
  ProjectBranchesView,
```

Replace `setBranch` (lines 145-152) with a job-starting version:

```tsx
  async function setBranch(id: string, branch: string) {
    setBusy(true);
    try {
      const { jobId } = await apiPost<StartJobResponse>(`/api/projects/branch?${q}`, { id, branch });
      localStorage.setItem(activeJobKey, jobId);
      setJobId(jobId);
      setJobOpen(true);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }
```

Pass the profile to the row (line 253-262):

```tsx
            <ProjectRow
              key={p.id}
              profile={profile}
              project={p}
              cliInstalled={system?.cli.installed ?? false}
              busy={busy || jobRunning}
              onPull={pull}
              onRemove={(p) => setRemoveTarget(p)}
              onBranch={setBranch}
              onCodegraph={codegraphAction}
            />
```

Replace the `ProjectRow` function (lines 313-377) with:

```tsx
function ProjectRow({
  profile,
  project,
  cliInstalled,
  busy,
  onPull,
  onRemove,
  onBranch,
  onCodegraph,
}: {
  profile: string;
  project: ProjectView;
  cliInstalled: boolean;
  busy: boolean;
  onPull: (id: string) => void;
  onRemove: (project: ProjectView) => void;
  onBranch: (id: string, branch: string) => void;
  onCodegraph: (id: string, action: "init" | "sync") => void;
}) {
  const [branch, setBranch] = useState(project.branch);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  useEffect(() => {
    setBranch(project.branch);
  }, [project.branch]);

  const loadBranches = useCallback(() => {
    setLoadingBranches(true);
    apiGet<ProjectBranchesView>(
      `/api/projects/branches?profile=${encodeURIComponent(profile)}&id=${encodeURIComponent(project.id)}`,
    )
      .then((v) => setOptions(v.branches))
      .catch(() => setOptions(null))
      .finally(() => setLoadingBranches(false));
  }, [profile, project.id]);
  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  const selected = branch.trim() || project.branch;
  const merged = options ? Array.from(new Set([selected, ...options])) : null;

  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {project.name} {statusBadge(project)}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{project.repoUrl}</div>
        <div className="truncate text-xs text-muted-foreground">
          最后拉取：{formatTime(project.lastPullAt)}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {codegraphBadge(project, cliInstalled)}
          {project.codegraph?.indexed && (
            <span>索引更新：{formatTime(project.codegraph.updatedAt)}</span>
          )}
        </div>
      </div>
      {merged ? (
        <div className="flex items-center gap-1">
          <Select
            value={selected}
            disabled={busy || loadingBranches}
            onValueChange={(v) => {
              if (v !== project.branch) onBranch(project.id, v);
            }}
          >
            <SelectTrigger className="h-8 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {merged.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" disabled={busy || loadingBranches} onClick={loadBranches}>
            刷新分支
          </Button>
        </div>
      ) : (
        <Input
          className="h-8 w-[130px]"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onBlur={() => {
            if (branch.trim() && branch !== project.branch) onBranch(project.id, branch.trim());
          }}
        />
      )}
      {cliInstalled && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onCodegraph(project.id, project.codegraph?.indexed ? "sync" : "init")}
        >
          {project.codegraph?.indexed ? "同步索引" : "建索引"}
        </Button>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onPull(project.id)}>
        拉取
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(project)}>
        移除
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and build**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json && pnpm build:web`
Expected: PASS; `src/ui/generated/index.html` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/views/WorkspaceView.tsx web/src/components/JobProgressDialog.tsx
git commit -m "feat(web): branch dropdown that switches the checkout"
```

(`src/ui/generated/` is gitignored — the build output is not committed.)

---

### Task 9: docs

**Files:**
- Modify: `README.zh.md:301-303`
- Modify: `README.md:301-303`

- [ ] **Step 1: Update the Chinese README**

In `README.zh.md`, after the **实时进度** bullet (line 301), insert:

```md
- **切换分支**：项目行的分支是下拉框，选项为该仓库分支（含远程分支；取不到时退化为手动输入）。选中后立即 `fetch` + 切换检出目录，并持久化；已索引项目随之增量同步。工作区有未提交改动时会拒绝切换并保留原分支。定时/手动拉取也按配置的分支进行（`fetch-only` 策略只取不切）。
```

- [ ] **Step 2: Update the English README**

In `README.md`, after the **Live progress** bullet (line 301), insert:

```md
- **Switch branch**: each project's branch is a dropdown of the repo's branches (remote branches included; degrades to manual input when listing fails). Selecting one immediately fetches and checks out that branch, persists it, and re-syncs the index for an already-indexed project. A dirty tree refuses the switch and keeps the old branch. Scheduled/manual pulls also target the configured branch (`fetch-only` never moves the tree).
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: document the project branch dropdown"
```

---

### Task 10: full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the focused suites**

Run: `pnpm exec vitest run tests/unit/git/git-ops.test.ts tests/unit/workspace/rollback.test.ts tests/unit/workspace/ledger.test.ts tests/integration/workspace/branch-switch.test.ts tests/integration/workspace/git-jobs.test.ts tests/integration/ui/workspace-api.test.ts tests/integration/ui/workspace-routes.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the broader workspace/ui suites**

Run: `pnpm exec vitest run tests/integration/workspace tests/integration/ui tests/unit/workspace tests/unit/git`
Expected: PASS.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm exec tsc --noEmit -p web/tsconfig.json && pnpm build:web`
Expected: PASS.

- [ ] **Step 4: Grep for leftovers**

Run: `rg -n "updateProjectBranch" src web tests`
Expected: no matches.

- [ ] **Step 5: No commit needed**

`pnpm build:web` only writes gitignored output under `src/ui/generated/`; verification leaves the tree clean. Run `git status --short` and confirm no tracked files changed.

---

## Notes for the implementer

- `switchProjectBranch` deliberately runs git outside `withProjectStore` so the `projects.json` lock is never held across a network `fetch`.
- The rollback for `branch-switch` is registered **before** `checkout` and committed **after** it succeeds; a cancel during `fetch`/`checkout` therefore reverts to `previousBranch`, while a cancel during the subsequent `codegraph.sync` only releases the index lock (existing `codegraph-sync` rollback).
- `fetch-only` is the one strategy that must not touch the working tree; both the on-demand switch and the pull-time alignment respect that. The on-demand switch is the user's explicit action, so it switches even when the schedule is `fetch-only`.
- `pnpm test` (the whole suite) has known environment/load flakiness on this machine (missing `sh`, timeouts under load); the focused suites above are the gate.
