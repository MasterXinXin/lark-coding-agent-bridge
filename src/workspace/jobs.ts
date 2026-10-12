import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'succeeded' | 'failed';
export type JobStream = 'stdout' | 'stderr' | 'info';

export interface JobLogLine {
  seq: number;
  stepId?: string;
  stream: JobStream;
  text: string;
  at: number;
}

export interface JobStep {
  id: string;
  name: string;
  status: JobStatus;
}

export interface JobSnapshot {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  steps: JobStep[];
  logs: JobLogLine[];
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface JobRegistryOptions {
  /** Max log lines kept per job; oldest lines are dropped first. Default 2000. */
  maxLinesPerJob?: number;
  /** Max completed jobs kept; oldest completed jobs are swept first. Default 50. */
  maxJobs?: number;
  /** How long completed jobs are retained. Default 600000 (10 min). */
  ttlMs?: number;
  /** Injectable clock, mainly for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_LINES_PER_JOB = 2000;
const DEFAULT_MAX_JOBS = 50;
const DEFAULT_TTL_MS = 600_000;
const REDACTED = '***';

interface InternalJob {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  steps: JobStep[];
  logs: JobLogLine[];
  redact: string[];
  nextSeq: number;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * In-memory registry of long-running workspace jobs (clone / pull), polled by
 * the UI. Bounded in size and line count so a long-lived process cannot leak:
 * completed jobs are swept by TTL and count on every `create`.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly maxLinesPerJob: number;
  private readonly maxJobs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: JobRegistryOptions = {}) {
    this.maxLinesPerJob = opts.maxLinesPerJob ?? DEFAULT_MAX_LINES_PER_JOB;
    this.maxJobs = opts.maxJobs ?? DEFAULT_MAX_JOBS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  create(input: { kind: string; label: string; redact?: string[] }): { id: string } {
    this.sweep();
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      kind: input.kind,
      label: input.label,
      status: 'running',
      steps: [],
      logs: [],
      redact: (input.redact ?? []).filter((s) => s.length > 0),
      nextSeq: 1,
      startedAt: this.now(),
    });
    return { id };
  }

  addStep(jobId: string, step: { id: string; name: string }): void {
    const job = this.active(jobId);
    if (!job) return;
    if (job.steps.some((s) => s.id === step.id)) return;
    job.steps.push({ id: step.id, name: step.name, status: 'running' });
  }

  setStepStatus(jobId: string, stepId: string, status: JobStatus): void {
    const job = this.active(jobId);
    if (!job) return;
    const step = job.steps.find((s) => s.id === stepId);
    if (step) step.status = status;
  }

  append(jobId: string, entry: { stepId?: string; stream: JobStream; text: string }): void {
    const job = this.active(jobId);
    if (!job) return;
    const at = this.now();
    for (const raw of entry.text.split(/\r\n|\r|\n/)) {
      if (raw.trim() === '') continue;
      const line: JobLogLine = {
        seq: job.nextSeq++,
        stream: entry.stream,
        text: this.scrub(job, raw),
        at,
      };
      if (entry.stepId !== undefined) line.stepId = entry.stepId;
      job.logs.push(line);
    }
    if (job.logs.length > this.maxLinesPerJob) {
      job.logs.splice(0, job.logs.length - this.maxLinesPerJob);
    }
  }

  finish(jobId: string, result?: unknown): void {
    const job = this.active(jobId);
    if (!job) return;
    job.status = 'succeeded';
    job.result = result;
    job.endedAt = this.now();
  }

  fail(jobId: string, error: string): void {
    const job = this.active(jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    job.endedAt = this.now();
  }

  get(jobId: string, since = 0): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      steps: job.steps.map((s) => ({ ...s })),
      logs: job.logs.filter((l) => l.seq > since).map((l) => ({ ...l })),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      startedAt: job.startedAt,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    };
  }

  /** A job that still accepts writes; terminal or unknown jobs yield undefined. */
  private active(jobId: string): InternalJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return undefined;
    return job;
  }

  private scrub(job: InternalJob, text: string): string {
    let out = text;
    for (const needle of job.redact) out = out.split(needle).join(REDACTED);
    return out;
  }

  private sweep(): void {
    const expiry = this.now() - this.ttlMs;
    const completed: InternalJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.endedAt === undefined) continue;
      if (job.endedAt < expiry) this.jobs.delete(job.id);
      else completed.push(job);
    }
    if (completed.length <= this.maxJobs) return;
    completed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const job of completed.slice(this.maxJobs)) this.jobs.delete(job.id);
  }
}
