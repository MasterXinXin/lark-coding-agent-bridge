import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';
import { defaultOperations } from '../../../src/workspace/operations';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

const roots: string[] = [];
let handle: UiServerHandle;
let rootDir: string;
let configPath: string;
let base: string;
// profile -> controls (a MutableProfileState/Controls-ish object)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let online: Map<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeControls(profile: string): Promise<any> {
  const root = (await loadRootConfig(configPath))!;
  return {
    configPath,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    ownerRefreshState: 'unknown',
    processId: 'test',
    refreshOwner: async () => {},
    restart: async () => {},
  };
}

function stubSupervisor(): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    channelFor: () => undefined,
    list: () =>
      [...online.keys()].map((p) => ({
        profile: p,
        agentKind: 'claude' as const,
        online: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        botName: `bot-${p}`,
      })),
    startProfile: async (p) => {
      online.set(p, await makeControls(p));
    },
    stopProfile: async (p) => {
      online.delete(p);
    },
    restartProfile: async () => {},
  };
}

function get(path: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { ...(token ? { 'x-ui-token': token } : {}), ...headers } });
}
function post(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ui-'));
  roots.push(rootDir);
  configPath = join(rootDir, 'config.json');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } })),
    configPath,
  );
  // second profile 'work' on disk (offline)
  const rc = (await loadRootConfig(configPath))!;
  await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
  rc.profiles.work = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...app, id: 'cli_work' } } });
  await saveRootConfig(rc, configPath);
  await writeActiveProfile(rootDir, 'claude');

  online = new Map();
  online.set('claude', await makeControls('claude')); // claude online, work offline

  handle = await startUiServer({ supervisor: stubSupervisor(), version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('ui server (supervisor-backed)', () => {
  it('rejects API calls without the token', async () => {
    expect((await get('/api/status')).status).toBe(401);
    expect((await get('/api/config', 'wrong-token-value')).status).toBe(401);
  });

  it('rejects cross-origin requests', async () => {
    const res = await get('/api/status', handle.token, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('serves the console shell without a token', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('控制台');
  });

  it('returns status and config for the active (online) profile', async () => {
    const status = await json(await get('/api/status', handle.token));
    expect(status).toMatchObject({ hosted: true, version: 'test', activeProfile: 'claude', online: 1 });

    const config = await json(await get('/api/config', handle.token));
    expect(config.mode).toBe('personal');
    expect(config.live).toBe(true);
  });

  it('applies a config change live to an online profile and persists it', async () => {
    const view = await json(
      await post('/api/config', handle.token, { mode: 'team', maxConcurrentRuns: 7, requireMentionInGroup: false }),
    );
    expect(view.mode).toBe('team');
    expect(view.live).toBe(true);
    expect(online.get('claude').profileConfig.mode).toBe('team'); // in-memory controls updated

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.mode).toBe('team');
  });

  it('reads and writes an offline profile on disk (deferred, live=false)', async () => {
    const view = await json(await get('/api/config?profile=work', handle.token));
    expect(view.live).toBe(false);

    const saved = await json(
      await post('/api/config?profile=work', handle.token, { mode: 'team' }),
    );
    expect(saved.live).toBe(false);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.profiles.work.mode).toBe('team');
    expect(disk.profiles.claude.mode).toBe('personal');
  });

  it('accepts a provider/model id for an opencode profile', async () => {
    const root = (await loadRootConfig(configPath))!;
    root.profiles.opencode = createDefaultProfileConfig({ agentKind: 'opencode', accounts: { app } });
    await saveRootConfig(root, configPath);

    const res = await post('/api/config?profile=opencode', handle.token, { model: 'anthropic/claude-sonnet-4-6' });
    expect(res.status).toBe(200);
    const view = await json(res);
    expect(view.model).toBe('anthropic/claude-sonnet-4-6');
    const saved = (await loadRootConfig(configPath))!;
    expect(saved.profiles.opencode?.preferences.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('adds and removes access entries', async () => {
    const added = await json(await post('/api/access', handle.token, { action: 'add', kind: 'user', id: 'ou_alice' }));
    expect(added.allowedUsers).toContain('ou_alice');
    const removed = await json(await post('/api/access', handle.token, { action: 'remove', kind: 'user', id: 'ou_alice' }));
    expect(removed.allowedUsers).not.toContain('ou_alice');
  });

  it('cancels a running workspace job via POST /api/jobs/:id/cancel', async () => {
    const work = defaultOperations.run(
      { id: 'route-cancel-1', opKind: 'add', label: '添加项目' },
      () => new Promise<void>(() => {}),
    );
    work.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));

    const res = await post('/api/jobs/route-cancel-1/cancel', handle.token, {});
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, id: 'route-cancel-1' });

    // Unknown or already-finished jobs report 404.
    expect((await post('/api/jobs/nope/cancel', handle.token, {})).status).toBe(404);
  });

  it('sets and clears a per-chat @-mention override, and drops it when the chat is removed', async () => {
    await json(await post('/api/access', handle.token, { action: 'add', kind: 'chat', id: 'oc_grp' }));

    // Set an override (respond to all — no @ needed).
    const set = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: false }),
    );
    expect(set.chatRequireMention).toEqual({ oc_grp: false });
    expect(online.get('claude').profileConfig.access.chatRequireMention).toEqual({ oc_grp: false });

    // Clear it (follow global) with null.
    const cleared = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: null }),
    );
    expect(cleared.chatRequireMention).toEqual({});

    // Re-set then remove the chat → override is dropped too.
    await json(await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: true }));
    const afterRemove = await json(
      await post('/api/access', handle.token, { action: 'remove', kind: 'chat', id: 'oc_grp' }),
    );
    expect(afterRemove.allowedChats).not.toContain('oc_grp');
    expect(afterRemove.chatRequireMention).toEqual({});
  });

  it('lists profiles with online flag from the supervisor', async () => {
    const { profiles } = await json(await get('/api/profiles', handle.token));
    const byName = Object.fromEntries(profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName.claude.running).toBe(true);
    expect(byName.work.running).toBe(false);
  });

  it('lists online channels from the supervisor', async () => {
    const { bots } = await json(await get('/api/bots', handle.token));
    expect(bots.map((b: { profileName: string }) => b.profileName)).toEqual(['claude']);
  });

  it('starts and stops a profile via the supervisor', async () => {
    expect((await post('/api/profiles/start', handle.token, { profile: 'work' })).status).toBe(200);
    expect(online.has('work')).toBe(true);
    expect((await post('/api/profiles/stop', handle.token, { profile: 'claude' })).status).toBe(200);
    expect(online.has('claude')).toBe(false);
  });

  it('returns 404 for an unknown QR registration session', async () => {
    const res = await get('/api/profiles/qr/status?sessionId=nope', handle.token);
    expect(res.status).toBe(404);
  });

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
});
