import { log } from '../core/logger';
import { createGitRunner, type GitRunner } from '../git/git-ops';
import { HttpError } from '../ui/http';
import { addProjects, listProjectTargets, pullProjects, switchProjectBranch } from '../ui/workspace-api';
import {
  createCodegraphHook,
  projectIndexInfo,
  type CodegraphHook,
  type CodegraphRunner,
  type CommandRunner,
  type ExecutableResolver,
} from './codegraph';
import { JobRegistry } from './jobs';
import { OperationCancelledError } from './operation-context';
import { defaultOperations, type OperationRegistry } from './operations';
import { createProgressWriter } from './output';

/** Process-wide registry backing the console's `GET /api/jobs/:id` route. */
export const jobRegistry = new JobRegistry();

export interface StartJobDeps {
  /** Git runner to use; defaults to the real `git` binary. Tests inject a recorder. */
  runner?: GitRunner;
  /** Registry to record into; defaults to the process-wide `jobRegistry`. */
  registry?: JobRegistry;
  /**
   * Strings to scrub from every log line / error message. Production passes
   * none: git credentials are supplied via environment (`gitEnvForAccount` /
   * credential helper) and never reach argv, stdout/stderr, or the job
   * `result`, so nothing needs redacting at this layer. `JobRegistry` keeps
   * the capability for future use.
   */
  redact?: string[];
  /** Test seam: a fully fake hook that bypasses detection and spawning. */
  codegraph?: CodegraphHook;
  /** Test seam: a recorder used to build the real hook. */
  codegraphRunner?: CodegraphRunner;
  /** Test seam: a recorder for the CLI install command. */
  commandRunner?: CommandRunner;
  /** Override the codegraph binary name. */
  codegraphBin?: string;
  /** Test seam: override executable resolution inside the hook. */
  codegraphResolve?: ExecutableResolver;
  /** Registry backing cancel/shutdown/reconcile; defaults to the process singleton. */
  operations?: OperationRegistry;
}

type OnStep = (info: { id: string; name: string }) => void;

/** `添加项目` label: the sole project's name when there's exactly one, else a count. */
function addLabel(body: unknown): string {
  const raw = body as { projects?: unknown };
  const items = Array.isArray(raw?.projects) ? raw.projects : [];
  if (items.length === 1) {
    const name = (items[0] as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return `添加 ${items.length} 个项目`;
}

/** `拉取` label: a specific project (`body.id`) or every project. */
function pullLabel(body: unknown): string {
  const id = (body as { id?: unknown })?.id;
  return typeof id === 'string' && id.trim() ? '拉取项目' : '拉取全部项目';
}

/** Job kinds surfaced to the console's progress dialog (`get`/`kindLabel`). */
type WorkspaceJobKind =
  | 'add'
  | 'pull'
  | 'branch'
  | 'codegraph'
  | 'codegraph-init'
  | 'codegraph-sync'
  | 'codegraph-cli-install'
  | 'codegraph-mcp-install';

/**
 * Create a job, stream `work`'s git output into it, and return its id
 * immediately. `work` runs fire-and-forget: success finishes the job, any
 * throw fails it. Errors never reject unhandled.
 */
function beginJob(
  kind: WorkspaceJobKind,
  label: string,
  meta: { profile: string; rootDir?: string },
  deps: StartJobDeps,
  work: (runner: GitRunner, onStep: OnStep, codegraph: CodegraphHook | undefined) => Promise<unknown>,
): { id: string } {
  const registry = deps.registry ?? jobRegistry;
  const operations = deps.operations ?? defaultOperations;
  const base = deps.runner ?? createGitRunner();
  const { id: jobId } = registry.create({ kind, label, redact: deps.redact ?? [] });

  let currentStep: string | undefined;
  // git writes its progress/errors to stderr but `onOutput` does not expose
  // which stream a chunk came from, so all chunks are recorded as stderr. The
  // writer collapses `\r` spinner frames and repeated percentage progress lines,
  // so a clone/pull/init does not flood the log with redraws.
  const writer = createProgressWriter((line) =>
    registry.append(jobId, {
      ...(currentStep ? { stepId: currentStep } : {}),
      stream: 'stderr',
      text: line,
    }),
  );
  const runner: GitRunner = (args, opts) =>
    base(args, { ...(opts ?? {}), onOutput: (chunk) => writer.push(chunk) });

  const onStep: OnStep = (info) => {
    registry.addStep(jobId, info);
    currentStep = info.id;
    registry.append(jobId, { stepId: info.id, stream: 'info', text: `开始处理 ${info.name}` });
  };

  void (async () => {
    try {
      registry.append(jobId, { stream: 'info', text: `任务已启动：${label}` });
      await operations.run(
        {
          id: jobId,
          opKind: kind,
          label,
          profile: meta.profile,
          ...(meta.rootDir ? { rootDir: meta.rootDir } : {}),
          ...(registry.get(jobId)?.startedAt !== undefined
            ? { startedAt: registry.get(jobId)!.startedAt }
            : {}),
        },
        async () => {
          // `add` only clones; it neither probes nor indexes codegraph, so skip
          // the CLI detection the hook would otherwise perform.
          const codegraph =
            deps.codegraph ??
            (kind === 'add'
              ? undefined
              : await createCodegraphHook({
                  ...(deps.codegraphRunner ? { runner: deps.codegraphRunner } : {}),
                  ...(deps.commandRunner ? { commandRunner: deps.commandRunner } : {}),
                  ...(deps.codegraphBin ? { bin: deps.codegraphBin } : {}),
                  ...(deps.codegraphResolve ? { resolve: deps.codegraphResolve } : {}),
                  onOutput: (chunk) => writer.push(chunk),
                }).catch((err) => {
                  log.fail('workspace', err, { step: 'codegraph-hook', jobId });
                  return undefined;
                }));
          const result = await work(runner, onStep, codegraph);
          writer.flush();
          registry.finish(jobId, result);
        },
      );
    } catch (err) {
      writer.flush();
      if (err instanceof OperationCancelledError) {
        registry.cancel(jobId, '已取消，正在回滚');
      } else {
        registry.fail(jobId, err instanceof Error ? err.message : String(err));
        log.fail('workspace', err, { step: 'workspace-job', jobId });
      }
    }
  })().catch(() => undefined);

  return { id: jobId };
}

/** Start a background `添加项目` (clone) job; resolves with the job id at once. */
export function startAddJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  return beginJob('add', addLabel(body), { profile, rootDir }, deps, (runner, onStep) =>
    addProjects(profile, rootDir, body, runner, onStep),
  );
}

/** Start a background `拉取` job (one project or all); resolves with the job id at once. */
export function startPullJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  return beginJob('pull', pullLabel(body), { profile, rootDir }, deps, (runner, onStep, codegraph) =>
    pullProjects(profile, rootDir, body, runner, onStep, 'manual', codegraph),
  );
}

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

interface CodegraphJobBody {
  action?: unknown;
  method?: unknown;
  id?: unknown;
  all?: unknown;
}

function codegraphLabel(raw: CodegraphJobBody): string {
  switch (raw.action) {
    case 'cli-install':
      return '安装 CodeGraph CLI';
    case 'mcp-install':
      return '接入 CodeGraph MCP';
    case 'init':
      return raw.all === true ? '初始化全部未索引项目' : '初始化项目索引';
    case 'sync':
      return raw.all === true ? '同步全部项目索引' : '同步项目索引';
    default:
      return 'CodeGraph 操作';
  }
}

/** Split the generic `codegraph` kind so the UI can label init vs sync vs install. */
function codegraphKind(raw: CodegraphJobBody): WorkspaceJobKind {
  switch (raw.action) {
    case 'cli-install':
      return 'codegraph-cli-install';
    case 'mcp-install':
      return 'codegraph-mcp-install';
    case 'init':
      return 'codegraph-init';
    case 'sync':
      return 'codegraph-sync';
    default:
      return 'codegraph';
  }
}

async function runCodegraphAction(
  profile: string,
  rootDir: string | undefined,
  raw: CodegraphJobBody,
  codegraph: CodegraphHook | undefined,
  onStep: OnStep,
): Promise<unknown> {
  if (!codegraph) throw new Error('codegraph 不可用：请先安装 CodeGraph CLI');
  const action = typeof raw.action === 'string' ? raw.action : '';
  if (action === 'cli-install') return codegraph.installCli(raw.method === 'npm' ? 'npm' : 'script');
  if (action === 'mcp-install') return codegraph.wireMcp();
  if (action !== 'init' && action !== 'sync') {
    throw new HttpError(400, `未知的 codegraph 操作：${action}`);
  }

  const targets = await listProjectTargets(profile, rootDir);
  let selected = targets;
  if (raw.all !== true) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const found = targets.find((t) => t.id === id);
    if (!found) throw new HttpError(404, `项目不存在：${id}`);
    selected = [found];
  }

  const results: Array<{ id: string; name: string; ok: boolean; detail?: string }> = [];
  for (const target of selected) {
    const info = await projectIndexInfo(target.dir);
    if (action === 'sync' && !info.indexed) {
      results.push({
        id: target.id,
        name: target.name,
        ok: false,
        detail: '未索引，已跳过（可先初始化）',
      });
      continue;
    }
    if (action === 'init' && info.indexed) {
      results.push({ id: target.id, name: target.name, ok: true, detail: '已索引，跳过' });
      continue;
    }
    onStep({ id: target.id, name: target.name });
    const outcome =
      action === 'init' ? await codegraph.init(target.dir) : await codegraph.sync(target.dir);
    results.push({ id: target.id, name: target.name, ...outcome });
  }
  return { results };
}

/** Start a background CodeGraph job (CLI install / MCP wire / init / sync). */
export function startCodegraphJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  const raw = (body && typeof body === 'object' ? body : {}) as CodegraphJobBody;
  return beginJob(
    codegraphKind(raw),
    codegraphLabel(raw),
    { profile, rootDir },
    deps,
    (_runner, onStep, codegraph) => runCodegraphAction(profile, rootDir, raw, codegraph, onStep),
  );
}
