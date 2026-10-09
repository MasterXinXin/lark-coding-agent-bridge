import { EventEmitter } from 'node:events';
import { log } from '../../core/logger';
import type { PromptOptions, SessionInfo } from './client';
import type { NormalizedEvent } from './events';
import { createV2EventNormalizer } from './events-v2';
import type { NormalizedEventStream, OpencodeTransport } from './transport';

/**
 * Minimal structural view of `@opencode/client`. We intentionally do not
 * import the SDK's generated types: they use a `T["prop"]` codegen shape that
 * is unwieldy to satisfy and would couple the bridge to an exact SDK release.
 * The methods/paths were verified against @opencode/client 2.0.26.
 */
interface SdkClient {
  session: {
    create(input?: unknown): Promise<Record<string, unknown>>;
    prompt(input: unknown): Promise<unknown>;
    interrupt(input: unknown): Promise<unknown>;
    switchModel(input: unknown): Promise<unknown>;
    switchAgent(input: unknown): Promise<unknown>;
  };
  model: {
    default(input?: unknown): Promise<{
      data?: { id?: string; providerID?: string; variant?: string } | null;
    }>;
  };
  permission: {
    reply(input: unknown): Promise<unknown>;
  };
  event: {
    subscribe(options?: { signal?: AbortSignal; onActivity?: () => void }): AsyncIterable<unknown>;
  };
}

export interface OpencodeV2ClientOptions {
  /** Base URL, or a getter (v2 may bind a free port at start time). */
  baseUrl: string | (() => string);
  /** `Authorization` header value (`Basic ...`) for the v2 server. */
  authHeader?: string;
  defaultAgent?: string;
  defaultModel?: string;
  /** Test seam: inject a pre-built SDK client instead of `import('@opencode/client')`. */
  sdkFactory?: () => Promise<SdkClient>;
}

/** Parse "providerID/modelID" into v2's `{ providerID, id }` shape. */
export function parseModelV2(input: string): { providerID: string; id: string } {
  const idx = input.indexOf('/');
  if (idx <= 0 || idx === input.length - 1) {
    throw new Error(`invalid model "${input}" — expected "providerID/modelID"`);
  }
  return { providerID: input.slice(0, idx), id: input.slice(idx + 1) };
}

/** v2 has no per-prompt `system` field, so the bridge prompt is prepended. */
function buildV2PromptText(o: PromptOptions): string {
  const body = o.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return o.system ? `${o.system}\n\n${body}` : body;
}

/**
 * opencode v2 transport. Speaks the `/api/*` HTTP API (Basic auth) via the
 * official `@opencode/client` SDK and maps its `V2Event` stream into the
 * bridge's `NormalizedEvent` currency.
 *
 * Notable v2 differences the client hides from the consumer:
 *  - model/agent are session-scoped (set via `switchModel`/`switchAgent`),
 *    not per-prompt.
 *  - permission replies need the sessionID, which we remember from the
 *    `permission.asked` event keyed by requestID.
 *  - the event stream is global, not `?directory=`-scoped.
 */
export class OpencodeV2Client implements OpencodeTransport {
  readonly apiVersion = 2 as const;

  private readonly opts: OpencodeV2ClientOptions;
  private sdkPromise: Promise<SdkClient> | null = null;
  /** Last model/agent we applied per session, to avoid redundant switches. */
  private readonly sessionConfig = new Map<string, { model?: string; agent?: string }>();
  /** sessionID → working directory, needed to resolve the directory-scoped default model. */
  private readonly sessionDirs = new Map<string, string>();
  /** requestID → sessionID, learned from `permission.asked`. */
  private readonly permissionSessions = new Map<string, string>();

  constructor(opts: OpencodeV2ClientOptions) {
    this.opts = opts;
  }

  private sdk(): Promise<SdkClient> {
    if (!this.sdkPromise) {
      this.sdkPromise = this.opts.sdkFactory
        ? this.opts.sdkFactory()
        : import('@opencode/client').then(({ OpenCode }) => {
            const baseUrl =
              typeof this.opts.baseUrl === 'function' ? this.opts.baseUrl() : this.opts.baseUrl;
            const headers = this.opts.authHeader
              ? { authorization: this.opts.authHeader }
              : undefined;
            return OpenCode.make({
              baseUrl,
              ...(headers ? { headers } : {}),
            }) as unknown as SdkClient;
          });
    }
    return this.sdkPromise;
  }

  async createSession(title?: string, directory?: string): Promise<SessionInfo> {
    const client = await this.sdk();
    const info = await client.session.create({
      ...(title ? { title } : {}),
      ...(directory ? { location: { directory } } : {}),
    });
    const id = typeof info?.id === 'string' ? info.id : undefined;
    if (!id) {
      throw new Error(
        `opencode v2 createSession: no id in response: ${JSON.stringify(info).slice(0, 300)}`,
      );
    }
    if (directory) this.sessionDirs.set(id, directory);
    return {
      id,
      ...(typeof info.title === 'string' ? { title: info.title } : {}),
      ...(directory ? { directory } : {}),
    };
  }

  async promptAsync(o: PromptOptions): Promise<void> {
    const client = await this.sdk();
    const model = o.model ?? this.opts.defaultModel;
    const agent = o.agent ?? this.opts.defaultAgent;
    await this.applySessionConfig(client, o.sessionId, model, agent);
    await client.session.prompt({ sessionID: o.sessionId, text: buildV2PromptText(o) });
  }

  async abortSession(id: string): Promise<void> {
    try {
      const client = await this.sdk();
      await client.session.interrupt({ sessionID: id });
    } catch (err) {
      log.warn('opencode.v2', 'abort-failed', {
        sessionId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async replyPermission(
    requestID: string,
    reply: 'once' | 'always' | 'reject',
    _directory?: string,
  ): Promise<void> {
    const sessionID = this.permissionSessions.get(requestID);
    if (!sessionID) {
      log.warn('opencode.v2', 'permission-reply-missing-session', { requestID, reply });
      return;
    }
    try {
      const client = await this.sdk();
      await client.permission.reply({ sessionID, requestID, decision: reply });
    } finally {
      this.permissionSessions.delete(requestID);
    }
  }

  createEventStream(_opts: { directory?: string; sessionID?: string }): NormalizedEventStream {
    return new OpencodeV2EventStream({
      getClient: () => this.sdk(),
      onPermissionAsked: (sessionID, requestID) => {
        this.permissionSessions.set(requestID, sessionID);
      },
    });
  }

  private async applySessionConfig(
    client: SdkClient,
    sessionID: string,
    model: string | undefined,
    agent: string | undefined,
  ): Promise<void> {
    const current = this.sessionConfig.get(sessionID) ?? {};
    if (model) {
      if (model !== current.model) {
        await client.session.switchModel({ sessionID, model: parseModelV2(model) });
        current.model = model;
      }
    } else if (current.model !== undefined) {
      // `/config` was cleared back to "follow opencode". v2 has no per-prompt
      // model, so the session keeps its explicit model unless we actively
      // switch it back to opencode's default; do that to honor the change
      // mid-conversation.
      const fallback = await this.resolveDefaultModel(client, sessionID);
      if (fallback) {
        await client.session.switchModel({ sessionID, model: fallback });
        current.model = undefined;
      } else {
        log.warn('opencode.v2', 'revert-model-no-default', { sessionId: sessionID });
      }
    }
    if (agent && agent !== current.agent) {
      await client.session.switchAgent({ sessionID, agent });
      current.agent = agent;
    }
    this.sessionConfig.set(sessionID, current);
  }

  /** Resolve opencode's directory-scoped default model, for "follow default". */
  private async resolveDefaultModel(
    client: SdkClient,
    sessionID: string,
  ): Promise<{ providerID: string; id: string; variant?: string } | null> {
    try {
      const directory = this.sessionDirs.get(sessionID);
      const out = await client.model.default(directory ? { location: { directory } } : {});
      const data = out?.data;
      if (data && typeof data.id === 'string' && typeof data.providerID === 'string') {
        return {
          providerID: data.providerID,
          id: data.id,
          ...(typeof data.variant === 'string' ? { variant: data.variant } : {}),
        };
      }
    } catch (err) {
      log.warn('opencode.v2', 'resolve-default-model-failed', {
        sessionId: sessionID,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/**
 * Subscribes to the v2 global event stream and emits `NormalizedEvent`s. The
 * global stream is not directory-scoped — callers (the session consumer)
 * filter by `sessionID`.
 */
export class OpencodeV2EventStream extends EventEmitter implements NormalizedEventStream {
  private readonly controller = new AbortController();
  private closed = false;
  private readonly normalize = createV2EventNormalizer();

  constructor(
    private readonly opts: {
      getClient: () => Promise<SdkClient>;
      onPermissionAsked?: (sessionID: string, requestID: string) => void;
    },
  ) {
    super();
  }

  async start(): Promise<void> {
    const client = await this.opts.getClient();
    if (this.closed) return;
    log.info('opencode.v2', 'event-subscribe');
    const iterable = client.event.subscribe({ signal: this.controller.signal });
    // v2's `server.connected` only fires once per process; synthesize a stream
    // `connected` so every consumer turn emits its `system` header exactly like
    // the v1 path. (A later `server.connected` is deduped downstream.)
    this.emit('event', { kind: 'connected' } satisfies NormalizedEvent);
    void this.pump(iterable);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }

  private async pump(iterable: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const event of iterable) {
        if (this.closed) break;
        const normalized = this.normalize(event);
        if (!normalized) continue;
        if (normalized.kind === 'permission') {
          this.opts.onPermissionAsked?.(normalized.sessionID, normalized.requestID);
        }
        this.emit('event', normalized);
      }
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('opencode.v2', 'event-stream-error', { message });
        this.emit('event', { kind: 'error', message } satisfies NormalizedEvent);
      }
    } finally {
      this.emit('close');
    }
  }
}
