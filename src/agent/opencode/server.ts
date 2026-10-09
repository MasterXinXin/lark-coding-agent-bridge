import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';

export interface ServeOptions {
  port: number;
  host: string;
  /** Override the opencode binary on $PATH. */
  opencodePath?: string;
  /** Max ms to wait for the server to accept TCP connections after spawn. */
  readyTimeoutMs?: number;
  /**
   * opencode HTTP API generation. v1 is unauthenticated (`/doc`, `/session`);
   * v2 speaks `/api/*` and requires Basic auth (see `authHeader`). Default 1.
   */
  apiVersion?: 1 | 2;
  /** Override the generated v2 server password (tests). */
  password?: string;
}

/** Resolve true when `port` on `host` can be bound (i.e. is currently free). */
function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * Pick a port for a v2 serve. Prefers `preferred`, but falls back to an
 * ephemeral port when it is taken — opencode's default port (4096) is
 * frequently occupied by the user's own `opencode serve` / desktop service, and
 * v2 must never share a server (different password). Exported for tests.
 */
export async function pickFreePort(host: string, preferred: number): Promise<number> {
  if (await portIsFree(host, preferred)) return preferred;
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Manages a child `opencode serve` process. Use `start()` to spawn and wait
 * for the HTTP listener to be ready before returning.
 *
 * v1: lazy + idempotent — if another opencode serve is already answering on
 * the configured port, the adapter attaches to it instead of spawning.
 *
 * v2: the bridge generates a process-scoped `OPENCODE_SERVER_PASSWORD`, injects
 * it into the child env, and (because v2 requires that password) never reuses a
 * foreign server. It picks a free port so a running opencode desktop service
 * on the default 4096 does not block it. The readiness probe authenticates with
 * the generated password, so a *foreign* server on the port is not mistaken for
 * ours.
 *
 * Adapter-scoped, NOT per-run: one OpencodeServer instance backs every
 * `OpencodeAdapter.run()` call. The process exits if serve dies unexpectedly
 * so we don't silently leak runs against a dead backend.
 */
export class OpencodeServer {
  private proc: ChildProcess | null = null;
  private stopped = false;
  /** True when we attached to an already-running serve (did not spawn). */
  private reused = false;
  /** True between spawning and the readiness probe settling. */
  private starting = false;
  private readonly apiVersion: 1 | 2;
  private readonly password: string | undefined;
  /** For v2, the port actually bound (may differ from `opts.port`). */
  private boundPort: number | null = null;

  constructor(private readonly opts: ServeOptions) {
    this.apiVersion = opts.apiVersion ?? 1;
    this.password =
      this.apiVersion === 2 ? (opts.password ?? randomBytes(24).toString('base64url')) : undefined;
  }

  get baseUrl(): string {
    return `http://${this.opts.host}:${this.boundPort ?? this.opts.port}`;
  }

  /**
   * `Authorization` header the v2 client must send, or undefined for v1.
   * Uses Basic auth with username `opencode` (opencode's serve convention).
   */
  get authHeader(): string | undefined {
    if (this.apiVersion !== 2 || !this.password) return undefined;
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
  }

  async start(): Promise<void> {
    if (this.proc || this.reused) return;

    if (this.apiVersion === 2) {
      // v2 is authenticated and never shared, so skip the reuse probe and just
      // secure a free port before spawning.
      this.boundPort = await pickFreePort(this.opts.host, this.opts.port);
      if (this.boundPort !== this.opts.port) {
        log.info('opencode.srv', 'port-in-use', {
          preferred: this.opts.port,
          bound: this.boundPort,
        });
      }
    } else if (await this.isReachable()) {
      this.reused = true;
      log.info('opencode.srv', 'reuse', { baseUrl: this.baseUrl, apiVersion: this.apiVersion });
      return;
    }

    const bin = this.opts.opencodePath ?? 'opencode';
    const args = ['serve', '--port', String(this.boundPort ?? this.opts.port), '--hostname', this.opts.host];
    const env = this.password
      ? { ...process.env, OPENCODE_SERVER_PASSWORD: this.password }
      : process.env;
    log.info('opencode.srv', 'spawn', { bin, args, apiVersion: this.apiVersion });
    const proc = spawnProcess(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    this.proc = proc;

    proc.stdout?.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) log.info('opencode.srv', 'stdout', { line });
    });
    proc.stderr?.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) log.warn('opencode.srv', 'stderr', { line });
    });
    this.starting = true;
    proc.on('exit', (code, signal) => {
      log.warn('opencode.srv', 'exit', { code, signal });
      this.proc = null;
      if (this.stopped) return;
      if (this.starting) {
        // Startup failure: don't kill the whole bridge. `waitForReady()`
        // surfaces a precise error to the caller.
        log.fail('opencode.srv', new Error('opencode serve exited during startup'), {
          code,
          signal,
        });
        return;
      }
      log.fail('opencode.srv', new Error('opencode serve died unexpectedly'), {
        code,
        signal,
      });
      process.exit(1);
    });
    proc.on('error', (err) => {
      log.fail('opencode.srv', err, { phase: 'spawn' });
    });

    try {
      await this.waitForReady();
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reused) return;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
  }

  private async isReachable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.authHeader) headers.authorization = this.authHeader;
      const path = this.apiVersion === 2 ? '/api/config' : '/doc';
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      if (await this.isReachable()) {
        log.info('opencode.srv', 'ready', { baseUrl: this.baseUrl, apiVersion: this.apiVersion });
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `opencode serve did not become ready at ${this.baseUrl} (is port ${this.boundPort ?? this.opts.port} in use?)`,
    );
  }
}
