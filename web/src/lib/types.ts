export type AgentKind = "claude" | "codex" | "opencode";
export type ProfileMode = "personal" | "team";
export type LarkCliIdentity = "bot-only" | "user-default";
export type MessageReply = "card" | "markdown" | "text";
export type CotMessages = "off" | "brief" | "detailed";

export interface Status {
  hosted: boolean;
  version: string;
  activeProfile?: string;
  online: number;
}

export interface BotInfo {
  id: string;
  pid: number;
  appId?: string;
  profileName: string;
  agentKind: AgentKind;
  version: string;
  botName?: string;
  startedAt?: string;
  uptimeMs: number;
}

export interface ProfileInfo {
  name: string;
  agentKind: AgentKind;
  active: boolean;
  running: boolean;
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ConfigView {
  profile: string;
  agentKind: AgentKind;
  mode: ProfileMode;
  model: string;
  models: ModelOption[];
  messageReply: MessageReply;
  showToolCalls: boolean;
  cotMessages: CotMessages;
  maxConcurrentRuns: number;
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentity;
  meeting: MeetingConfig;
  access: {
    allowedUsers: string[];
    allowedChats: string[];
    admins: string[];
    /** chat_id → per-chat @-mention override (overrides requireMentionInGroup). */
    chatRequireMention: Record<string, boolean>;
  };
  /** True when this profile's process hosts the UI (edits apply live). */
  live?: boolean;
}

/** A chat the bot is a member of, for the group picker. */
export interface KnownChat {
  id: string;
  name: string;
}

/** Owner user-identity auth status (for the "我的群" picker). */
export interface UserAuthStatus {
  loggedIn: boolean;
  userName?: string;
  openId?: string;
  scopes: string[];
}

/** OAuth device-flow start response. */
export interface DeviceLogin {
  verificationUrl: string;
  userCode?: string;
  deviceCode: string;
  expiresIn?: number;
}

/** A group the owner is in (for the "我的群" picker). */
export interface UserChat {
  id: string;
  name: string;
  botInIt: boolean;
}

// ── in-meeting agent ──────────────────────────────────────────────────────────

export type MeetingRespondIn = "meeting" | "im" | "both";
export type MeetingSummaryTarget = "origin" | "owner";

export interface MeetingConfig {
  enabled: boolean;
  autoJoinOnInvite: boolean;
  transcript: { keep: number; stabilizeMs: number };
  respondIn: MeetingRespondIn;
  trigger: string;
  pollIntervalMs: number;
  summaryOnEnd: boolean;
  summaryTarget: MeetingSummaryTarget;
}

export interface MeetingSessionInfo {
  meetingId: string;
  meetingNo: string;
  topic?: string;
  startedAt: string;
  source: "push" | "poll";
  transcriptLines: number;
  participants: number;
  ingested: number;
  /** Raw activity items per event type; `?`-prefixed keys were unparseable. */
  eventCounts: Record<string, number>;
  ended: boolean;
}

export interface MeetingsView {
  available: boolean;
  reason?: string;
  sessions: MeetingSessionInfo[];
  push: { hooked: boolean; reason?: string; received: number; lastAt?: string };
}

export interface MeetingPreflight {
  status: "ok" | "scope-missing" | "not-in-beta" | "unknown";
  message: string;
  missingScopes: string[];
  /** Feishu scope-apply URL — opaque, render as link/QR only. */
  consoleUrl?: string;
  requiredEvents: string[];
  /** Every app scope the feature needs, with what each unlocks. */
  requiredScopes: { scope: string; purpose: string }[];
  betaChatUrl?: string;
}

export interface OnboardState {
  hasConfig: boolean;
  activeProfile?: string;
  profiles: string[];
  detectedAgents: AgentKind[];
}

// ── workspace & git projects ─────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: DirEntry[];
  roots?: DirEntry[];
}

export interface RepoStatus {
  branch?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export type PullStrategy = "ff-only" | "fetch-only" | "reset-hard";

export interface PullSchedule {
  enabled: boolean;
  intervalMinutes: number;
  strategy: PullStrategy;
  notifyOnFailure: boolean;
}

export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  accountId?: string;
  absolutePath: string;
  exists: boolean;
  status: RepoStatus;
  lastPullAt?: string;
  codegraph: CodegraphIndexInfo;
}

export interface ProjectsView {
  workspaceDir?: string;
  projects: ProjectView[];
  schedule: PullSchedule;
}

export interface ProjectBranchesView {
  branches: string[];
  current?: string;
}

export interface RemovedProject {
  id: string;
  dir?: string;
  deleted: boolean;
  warning?: string;
}

export interface RemoveProjectsView extends ProjectsView {
  removed?: RemovedProject;
}

// ── pull history (scheduled & manual) ────────────────────────────────────────

export type PullResult = "updated" | "up-to-date" | "skipped" | "failed";
export type PullTrigger = "schedule" | "manual";

export interface PullRecord {
  ts: string;
  projectId: string;
  name: string;
  branch: string;
  result: PullResult;
  detail: string;
  durationMs: number;
  trigger: PullTrigger;
}

export interface PullHistoryView {
  records: PullRecord[];
}

// ── background jobs (project add / pull) ─────────────────────────────────────

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";
export type JobStream = "stdout" | "stderr" | "info";

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

export interface JobView {
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

export interface StartJobResponse {
  jobId: string;
}

// ── codegraph (per-project code index) ───────────────────────────────────────

export interface CodegraphIndexInfo {
  indexed: boolean;
  dbPath?: string;
  dbSizeBytes?: number;
  updatedAt?: string;
}

export interface CodegraphCliStatus {
  installed: boolean;
  version?: string;
  binaryPath?: string;
}

export type CodegraphMcpState = "installed" | "missing" | "unknown";

export interface CodegraphMcpStatus {
  state: CodegraphMcpState;
  configPath?: string;
}

export interface CodegraphSystemView {
  cli: CodegraphCliStatus;
  mcp: CodegraphMcpStatus;
}

export interface CodegraphStats {
  initialized: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
  pendingChanges: { added: number; modified: number; removed: number };
}

// ── global git accounts & provider repos ─────────────────────────────────────

export type GitProvider = "github" | "gitlab" | "gitea" | "other";

export interface GitAccount {
  id: string;
  label: string;
  provider: GitProvider;
  baseUrl: string;
  username?: string;
  /** True when a token is stored; the token itself is never returned. */
  hasToken: boolean;
}

export interface AccountsView {
  accounts: GitAccount[];
}

export interface RemoteRepo {
  id: string;
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface ReposView {
  repos: RemoteRepo[];
  hasMore: boolean;
  page: number;
}

export interface AccountTestResult {
  ok: boolean;
  username?: string;
  repoCount?: number;
  message?: string;
}
