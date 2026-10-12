import type { LarkChannel } from '@larksuite/channel';
import type { KnownChat } from '../bot/lark-info';
import type { MutableProfileState } from '../config/config-ops';
import type { Controls } from '../commands';
import type { FetchLike } from '../git/providers';
import type { GitRunner } from '../git/git-ops';
import type { CodegraphHook, CodegraphRunner, CommandRunner } from '../workspace/codegraph';
import type { JobRegistry } from '../workspace/jobs';
import type { ManagedStatus } from '../runtime/supervisor';
import type { CodegraphSystemView } from './codegraph-api';

/**
 * The live per-profile runtime the console edits. The supervisor's `Controls`
 * for an online profile structurally satisfies this, so the console reads/writes
 * config through the same `config-ops` logic the chat `/config` form uses, and
 * changes apply live for any online profile.
 */
export interface UiRuntime extends MutableProfileState {
  botOwnerId?: string;
  knownChats?: KnownChat[];
  refreshOwner(channel?: LarkChannel): Promise<void>;
  restart(opts?: { wait?: boolean }): Promise<void>;
}

/** The subset of the supervisor the console needs (structurally satisfied). */
export interface UiSupervisor {
  isOnline(profile: string): boolean;
  controlsFor(profile: string): Controls | undefined;
  channelFor(profile: string): LarkChannel | undefined;
  list(): ManagedStatus[];
  startProfile(profile: string): Promise<void>;
  stopProfile(profile: string): Promise<void>;
  restartProfile(profile: string): Promise<void>;
}

/** Everything the console server needs from the supervisor host. */
export interface UiServerDeps {
  supervisor: UiSupervisor;
  /** Bridge version string (for the status endpoint). */
  version: string;
  /** Config root dir (LARK_CHANNEL_HOME); undefined = default. */
  rootDir?: string;
  /** Bind host; defaults to 127.0.0.1. */
  host?: string;
  /** Bind port; 0 (default) picks an ephemeral port. */
  port?: number;
  /** Injectable fetch for git-provider calls (tests pass a mock; defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Injectable git runner for project add/pull jobs (tests pass a recorder). */
  gitRunner?: GitRunner;
  /** Job registry backing `GET /api/jobs/:id`; defaults to the process-wide registry. */
  jobRegistry?: JobRegistry;
  /** Injectable codegraph hook for jobs (tests pass a fake). */
  codegraph?: CodegraphHook;
  /** Injectable codegraph runner (tests pass a recorder). */
  codegraphRunner?: CodegraphRunner;
  /** Injectable command runner for CLI install (tests pass a recorder). */
  commandRunner?: CommandRunner;
  /** Override the system-status probe (tests pass a stub). */
  codegraphStatus?: () => Promise<CodegraphSystemView>;
}

export interface UiServerHandle {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}
