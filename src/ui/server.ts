import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { log } from '../core/logger';
import { readActiveProfile } from '../config/profile-store';
import type { MutableProfileState } from '../config/config-ops';
import consoleHtml from './generated/index.html';
import {
  addBotToChatView,
  meetingJoin,
  meetingPreflight,
  meetingLeave,
  meetingsView,
  applyConfig,
  applyConfigToDisk,
  buildConfigView,
  listChats,
  loadProfileState,
  mutateAccess,
  userAuthStatus,
  userChatsView,
  userLoginComplete,
  userLoginStart,
} from './api';
import { activateProfile, listBots, listProfiles } from './fleet';
import {
  accountsView,
  branchesView,
  deleteAccount,
  reposView,
  saveAccount,
  testAccount,
} from './git-api';
import { onboardCreate, onboardState, onboardValidate } from './onboard';
import { finishQrRegistration, qrStatus, startQrRegistration } from './qr-register';
import {
  checkToken,
  HttpError,
  isLocalRequest,
  readJsonBody,
  sendHtml,
  sendJson,
} from './http';
import {
  projectBranchesView,
  projectsView,
  readPullHistory,
  removeProject,
  setSchedule,
  getSchedule,
  setWorkspaceDir,
} from './workspace-api';
import { browseDirectory } from '../workspace/dir-browse';
import {
  jobRegistry,
  startAddJob,
  startBranchJob,
  startCodegraphJob,
  startPullJob,
  type StartJobDeps,
} from '../workspace/git-jobs';
import { cancelOperation, cancelOperationsForProfile } from '../workspace/operations';
import { codegraphProjectStatsView, codegraphSystemView } from './codegraph-api';
import type { Controls } from '../commands';
import type { UiServerDeps, UiServerHandle } from './types';

const DEFAULT_HOST = '127.0.0.1';

/**
 * Start the supervisor's single management console. Binds 127.0.0.1, mints a
 * random per-process token gating every `/api/*` call, rejects non-localhost /
 * cross-origin. Backed by the supervisor: it can list/start/stop/configure any
 * profile in-process (online → live; offline → written to disk).
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const host = deps.host ?? DEFAULT_HOST;
  const token = randomBytes(32).toString('hex');

  const server = createServer((req, res) => {
    handle(req, res, deps, token).catch((err) => {
      log.warn('ui', 'request-failed', { err: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, host, () => resolve((server.address() as AddressInfo).port));
  });

  const url = `http://${host}:${port}/?token=${token}`;
  log.info('ui', 'listening', { url: `http://${host}:${port}` });

  return {
    url,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  token: string,
): Promise<void> {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    if (path === '/' || path === '/index.html') sendHtml(res, consoleHtml);
    else sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (!checkToken(req, url, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  try {
    await route(req, res, deps, url);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }
}

/** Resolve the target profile's state + whether edits apply live (online). */
async function resolveTargetState(
  deps: UiServerDeps,
  url: URL,
): Promise<{ profile: string; state: MutableProfileState; live: boolean; controls?: Controls }> {
  const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
  if (!profile) throw new HttpError(400, 'no profile');
  const controls = deps.supervisor.controlsFor(profile);
  if (controls) return { profile, state: controls, live: true, controls };
  return { profile, state: await loadProfileState(profile, deps.rootDir), live: false };
}

/** Console deps → the workspace job layer's injectable deps. */
function jobDeps(deps: UiServerDeps): StartJobDeps {
  return {
    ...(deps.gitRunner ? { runner: deps.gitRunner } : {}),
    registry: deps.jobRegistry ?? jobRegistry,
    ...(deps.codegraph ? { codegraph: deps.codegraph } : {}),
    ...(deps.codegraphRunner ? { codegraphRunner: deps.codegraphRunner } : {}),
    ...(deps.commandRunner ? { commandRunner: deps.commandRunner } : {}),
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  url: URL,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const g = method === 'GET';
  const p = method === 'POST';
  const d = method === 'DELETE';
  const sup = deps.supervisor;

  if (path === '/api/status' && g) {
    sendJson(res, 200, {
      hosted: true,
      version: deps.version,
      activeProfile: await readActiveProfile(deps.rootDir),
      online: sup.list().length,
    });
    return;
  }

  // --- online channels ---
  if (path === '/api/bots' && g) {
    sendJson(res, 200, { bots: listBots(sup, deps.version, Date.now()) });
    return;
  }

  // --- profiles ---
  if (path === '/api/profiles' && g) {
    sendJson(res, 200, { profiles: await listProfiles(sup, deps.rootDir) });
    return;
  }
  if (path === '/api/profiles/start' && p) {
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    try {
      await sup.startProfile(body.profile);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    sendJson(res, 200, { ok: true, profile: body.profile });
    return;
  }
  if (path === '/api/profiles/stop' && p) {
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    // Cancel any workspace job the profile owns before taking it offline.
    await cancelOperationsForProfile(body.profile, 'profile-stopped').catch(() => undefined);
    await sup.stopProfile(body.profile);
    sendJson(res, 200, { ok: true, profile: body.profile });
    return;
  }
  if (path === '/api/profiles/activate' && p) {
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await activateProfile(body.profile, deps.rootDir));
    return;
  }
  if (path === '/api/profiles/validate' && p) {
    sendJson(res, 200, await onboardValidate(await readJsonBody(req)));
    return;
  }
  if (path === '/api/profiles/qr/start' && p) {
    sendJson(res, 200, await startQrRegistration(deps.rootDir));
    return;
  }
  if (path === '/api/profiles/qr/status' && g) {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) throw new HttpError(400, 'sessionId is required');
    sendJson(res, 200, qrStatus(sessionId));
    return;
  }
  if (path === '/api/profiles/qr/finish' && p) {
    sendJson(res, 200, await finishQrRegistration(await readJsonBody(req), deps.rootDir));
    return;
  }
  if (path === '/api/profiles' && p) {
    sendJson(res, 200, await onboardCreate(await readJsonBody(req), deps.rootDir));
    return;
  }
  if (path === '/api/onboard/state' && g) {
    sendJson(res, 200, await onboardState(deps.rootDir));
    return;
  }

  // --- per-profile config ---
  if (path === '/api/config' && g) {
    const { state, live } = await resolveTargetState(deps, url);
    sendJson(res, 200, buildConfigView(state, live));
    return;
  }
  if (path === '/api/config' && p) {
    const { state, live, controls } = await resolveTargetState(deps, url);
    const body = await readJsonBody(req);
    sendJson(res, 200, live && controls ? await applyConfig(controls, body) : await applyConfigToDisk(state, body));
    return;
  }
  if (path === '/api/access' && p) {
    const { state } = await resolveTargetState(deps, url);
    sendJson(res, 200, await mutateAccess(state, await readJsonBody(req)));
    return;
  }
  if (path === '/api/chats' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    sendJson(res, 200, await listChats(profile ? sup.channelFor(profile) : undefined));
    return;
  }

  // --- "我的群": owner's groups via user identity (lark-cli device-flow auth) ---
  if (path === '/api/auth/status' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await userAuthStatus(profile, deps.rootDir));
    return;
  }
  if (path === '/api/auth/login/start' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; scopes?: unknown };
    const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'profile is required');
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string')
      : undefined;
    sendJson(res, 200, await userLoginStart(profile, deps.rootDir, scopes));
    return;
  }
  if (path === '/api/auth/login/complete' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; deviceCode?: string };
    const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await userLoginComplete(profile, deps.rootDir, body));
    return;
  }
  if (path === '/api/user-chats' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const query = url.searchParams.get('query') ?? undefined;
    const pageToken = url.searchParams.get('pageToken') ?? undefined;
    sendJson(res, 200, await userChatsView(profile, deps.rootDir, sup.channelFor(profile), { query, pageToken }));
    return;
  }
  if (path === '/api/chats/add-bot' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; chatId?: string };
    const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await addBotToChatView(profile, deps.rootDir, body));
    return;
  }

  // --- workspace & git projects ---
  if (path === '/api/workspace/dir' && g) {
    const target = url.searchParams.get('path') ?? undefined;
    try {
      sendJson(res, 200, await browseDirectory(target));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (path === '/api/workspace/root' && p) {
    const { profile, state } = await resolveTargetState(deps, url);
    sendJson(res, 200, await setWorkspaceDir(profile, deps.rootDir, await readJsonBody(req), state));
    return;
  }
  if (path === '/api/projects' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await projectsView(profile, deps.rootDir));
    return;
  }
  if (path === '/api/projects' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startAddJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/projects/remove' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await removeProject(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/projects/branches' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const id = url.searchParams.get('id') ?? '';
    if (!id) throw new HttpError(400, 'id is required');
    sendJson(res, 200, await projectBranchesView(profile, deps.rootDir, id));
    return;
  }
  if (path === '/api/projects/branch' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startBranchJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/projects/pull' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startPullJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  // --- codegraph (per-project code index) ---
  if (path === '/api/codegraph' && g) {
    const status = deps.codegraphStatus ?? codegraphSystemView;
    sendJson(res, 200, await status());
    return;
  }
  if (path === '/api/codegraph/project' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const id = url.searchParams.get('id') ?? '';
    if (!id) throw new HttpError(400, 'id is required');
    sendJson(res, 200, await codegraphProjectStatsView(profile, deps.rootDir, id, deps.codegraphRunner));
    return;
  }
  if (path === '/api/codegraph/cli/install' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'cli-install' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/mcp/install' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { action: 'mcp-install' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/init' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'init' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/sync' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'sync' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/schedule' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await getSchedule(profile, deps.rootDir));
    return;
  }
  if (path === '/api/schedule' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await setSchedule(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/pull-history' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const rawLimit = url.searchParams.get('limit');
    const n = rawLimit && rawLimit.trim() ? Number(rawLimit) : 50;
    const limit = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 50;
    sendJson(res, 200, { records: await readPullHistory(profile, deps.rootDir, limit) });
    return;
  }

  // --- global git accounts & provider repos ---
  if (path === '/api/git/accounts' && g) {
    sendJson(res, 200, await accountsView(deps.rootDir));
    return;
  }
  if (path === '/api/git/accounts' && p) {
    sendJson(res, 200, await saveAccount(deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/git/accounts' && d) {
    const id = url.searchParams.get('id') ?? '';
    sendJson(res, 200, await deleteAccount(deps.rootDir, { id }));
    return;
  }
  if (path === '/api/git/accounts/test' && p) {
    sendJson(res, 200, await testAccount(deps.rootDir, await readJsonBody(req), deps.fetchImpl));
    return;
  }
  if (path === '/api/git/repos' && g) {
    const account = url.searchParams.get('account') ?? undefined;
    const query = url.searchParams.get('query') ?? undefined;
    const page = Number(url.searchParams.get('page') ?? '1') || 1;
    sendJson(
      res,
      200,
      await reposView(
        deps.rootDir,
        { ...(account ? { accountId: account } : {}), ...(query ? { query } : {}), page },
        deps.fetchImpl,
      ),
    );
    return;
  }
  if (path === '/api/git/branches' && g) {
    const account = url.searchParams.get('account') ?? undefined;
    const repo = url.searchParams.get('repo') ?? undefined;
    sendJson(
      res,
      200,
      await branchesView(
        deps.rootDir,
        { ...(account ? { accountId: account } : {}), ...(repo ? { repo } : {}) },
        deps.fetchImpl,
      ),
    );
    return;
  }

  // --- in-meeting agent (智能体入会) ---
  if (path === '/api/meetings' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const controls = sup.controlsFor(profile);
    // Falls back to disk config so a stopped profile still reports why it's
    // unavailable rather than looking broken.
    const enabled = controls
      ? controls.profileConfig.meeting.enabled
      : (await loadProfileState(profile, deps.rootDir)).profileConfig.meeting.enabled;
    sendJson(res, 200, meetingsView(controls?.meeting, enabled));
    return;
  }
  if (path === '/api/meetings/preflight' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    // The probe needs some user open_id; the bot owner is the natural choice.
    const probeUserId = sup.controlsFor(profile)?.botOwnerId;
    sendJson(res, 200, await meetingPreflight(profile, deps.rootDir, probeUserId));
    return;
  }
  if (path === '/api/meetings/join' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; meetingNo?: string };
    const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await meetingJoin(sup.controlsFor(profile)?.meeting, body));
    return;
  }
  if (path === '/api/meetings/leave' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; meetingId?: string };
    const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await meetingLeave(sup.controlsFor(profile)?.meeting, body));
    return;
  }

  // --- background job progress (project add/pull) ---
  if (path.startsWith('/api/jobs/') && g) {
    const id = decodeURIComponent(path.slice('/api/jobs/'.length));
    const n = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    const snap = (deps.jobRegistry ?? jobRegistry).get(id, since);
    if (!snap) throw new HttpError(404, '任务不存在或已过期');
    sendJson(res, 200, snap);
    return;
  }
  if (path.startsWith('/api/jobs/') && p && path.endsWith('/cancel')) {
    const id = decodeURIComponent(path.slice('/api/jobs/'.length, -'/cancel'.length));
    const cancelled = await cancelOperation(id, 'user-cancelled');
    if (!cancelled) throw new HttpError(404, '任务不存在或已结束');
    sendJson(res, 200, { ok: true, id });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
