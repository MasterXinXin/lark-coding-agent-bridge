import { log } from '../core/logger';
import { createGitRunner, type GitRunner } from '../git/git-ops';
import { addProjects, pullProjects } from '../ui/workspace-api';
import { JobRegistry } from './jobs';

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

/**
 * Create a job, stream `work`'s git output into it, and return its id
 * immediately. `work` runs fire-and-forget: success finishes the job, any
 * throw fails it. Errors never reject unhandled.
 */
function beginJob(
  kind: 'add' | 'pull',
  label: string,
  deps: StartJobDeps,
  work: (runner: GitRunner, onStep: OnStep) => Promise<unknown>,
): { id: string } {
  const registry = deps.registry ?? jobRegistry;
  const base = deps.runner ?? createGitRunner();
  const { id: jobId } = registry.create({ kind, label, redact: deps.redact ?? [] });

  let currentStep: string | undefined;
  // git writes its progress/errors to stderr but `onOutput` does not expose
  // which stream a chunk came from, so all git chunks are recorded as stderr.
  const runner: GitRunner = (args, opts) =>
    base(args, {
      ...(opts ?? {}),
      onOutput: (chunk) =>
        registry.append(jobId, {
          ...(currentStep ? { stepId: currentStep } : {}),
          stream: 'stderr',
          text: chunk,
        }),
    });

  const onStep: OnStep = (info) => {
    registry.addStep(jobId, info);
    currentStep = info.id;
    registry.append(jobId, { stepId: info.id, stream: 'info', text: `开始处理 ${info.name}` });
  };

  void (async () => {
    try {
      registry.append(jobId, { stream: 'info', text: `任务已启动：${label}` });
      registry.finish(jobId, await work(runner, onStep));
    } catch (err) {
      registry.fail(jobId, err instanceof Error ? err.message : String(err));
      log.fail('workspace', err, { step: 'git-job', jobId });
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
  return beginJob('add', addLabel(body), deps, (runner, onStep) =>
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
  return beginJob('pull', pullLabel(body), deps, (runner, onStep) =>
    pullProjects(profile, rootDir, body, runner, onStep),
  );
}
