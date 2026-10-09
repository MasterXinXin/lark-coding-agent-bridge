import type { EventEmitter } from 'node:events';
import type { PromptOptions, SessionInfo } from './client';

/**
 * The subset of the opencode HTTP client the session consumer drives. Both the
 * v1 client (`OpencodeClient`) and the v2 client (`OpencodeV2Client`)
 * implement it, so `OpencodeSessionConsumer` — and everything downstream — is
 * API-version agnostic.
 */
export interface OpencodeSessionClient {
  createSession(title?: string, directory?: string): Promise<SessionInfo>;
  abortSession(id: string): Promise<void>;
  replyPermission(
    requestID: string,
    reply: 'once' | 'always' | 'reject',
    directory?: string,
  ): Promise<void>;
  promptAsync(o: PromptOptions): Promise<void>;
}

/**
 * Event-stream shape the consumer subscribes to. `OpencodeEventStream` (v1)
 * and `OpencodeV2EventStream` both extend `EventEmitter` and expose
 * `start()`/`close()`, emitting `event` (a `NormalizedEvent`) and `close`.
 */
export interface NormalizedEventStream extends EventEmitter {
  start(): Promise<void>;
  close(): void;
}

/**
 * A full opencode transport: the session client plus a factory for the
 * version-specific event stream. The adapter selects one transport per API
 * version; the consumer only ever sees `OpencodeSessionClient`.
 */
export interface OpencodeTransport extends OpencodeSessionClient {
  readonly apiVersion: 1 | 2;
  createEventStream(opts: { directory?: string; sessionID?: string }): NormalizedEventStream;
}
