import {
  claudeCapability,
  codexCapability,
  opencodeCapability,
  type AgentCapability,
  type PromptInjectionMode,
} from '../agent/capability';
import { roleScope, type RoleScopeCapability } from '../agent/role-catalog';
import type { MutableProfileState } from '../config/config-ops';
import {
  normalizeRole,
  ROLE_PROMPT_MAX_BYTES,
  truncateUtf8,
  type AgentKind,
} from '../config/profile-schema';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import { HttpError } from './http';

export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** How this agent injects the role (from its capability). */
  injection: PromptInjectionMode;
  /** How far MCP / skill scope can be controlled per bridge (2b enforces). */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
  /** Stored MCP whitelist; absent = unrestricted. */
  mcpEnabled?: string[];
  /** Stored skill whitelist; absent = unrestricted. */
  skillsEnabled?: string[];
  live: boolean;
}

function capabilityFor(agentKind: AgentKind, state: MutableProfileState): AgentCapability {
  switch (agentKind) {
    case 'claude':
      return claudeCapability(state.profileConfig);
    case 'codex':
      return codexCapability(state.profileConfig);
    case 'opencode':
      return opencodeCapability(state.profileConfig);
  }
}

/** Read the profile's role view (online state is the live `Controls`, offline is disk). */
export function buildRoleView(state: MutableProfileState, live: boolean): RoleView {
  const agentKind = state.profileConfig.agentKind;
  return {
    profile: state.profile,
    agentKind,
    prompt: state.profileConfig.role?.prompt ?? '',
    injection: capabilityFor(agentKind, state).promptInjection,
    capabilities: roleScope(agentKind),
    ...(state.profileConfig.role?.mcpEnabled !== undefined
      ? { mcpEnabled: state.profileConfig.role.mcpEnabled }
      : {}),
    ...(state.profileConfig.role?.skillsEnabled !== undefined
      ? { skillsEnabled: state.profileConfig.role.skillsEnabled }
      : {}),
    live,
  };
}

/**
 * Persist the profile's role (under the config file lock) and refresh the
 * in-memory state. `Controls` structurally satisfies `MutableProfileState`, so
 * an online profile picks the change up on its next run without a restart.
 * Phase 1 writes only `prompt`; phase 2 extends the parsed body with whitelists.
 */
export async function saveRoleConfig(
  state: MutableProfileState,
  body: unknown,
  live = false,
): Promise<RoleView> {
  const parsed = parseRoleBody(body);
  try {
    await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) throw new Error('config file not found');
      const profile = root.profiles[state.profile];
      if (!profile) throw new HttpError(404, `profile not found: ${state.profile}`);
      const existing = profile.role;
      // `parsed` may carry `null` (= clear); `normalizeRole` treats null as absent.
      const candidate = {
        prompt: parsed.prompt,
        ...(parsed.mcpEnabled !== undefined
          ? { mcpEnabled: parsed.mcpEnabled }
          : existing?.mcpEnabled !== undefined
            ? { mcpEnabled: existing.mcpEnabled }
            : {}),
        ...(parsed.skillsEnabled !== undefined
          ? { skillsEnabled: parsed.skillsEnabled }
          : existing?.skillsEnabled !== undefined
            ? { skillsEnabled: existing.skillsEnabled }
            : {}),
      };
      const merged = normalizeRole(candidate);
      const next = { ...profile };
      if (merged) next.role = merged;
      else delete next.role;
      root.profiles[state.profile] = next;
      await saveRootConfig(root, state.configPath);
      state.profileConfig = root.profiles[state.profile]!;
      state.cfg = runtimeProfileConfig(root, state.profile);
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return buildRoleView(state, live);
}

interface ParsedRoleBody {
  prompt: string;
  /** Present iff the body supplied `mcpEnabled`; `null` = clear. */
  mcpEnabled?: string[] | null;
  /** Present iff the body supplied `skillsEnabled`; `null` = clear. */
  skillsEnabled?: string[] | null;
}

/** Parse `{ prompt, mcpEnabled?, skillsEnabled? }`; whitelists accept a string[] or null (clear). */
function parseRoleBody(body: unknown): ParsedRoleBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  const raw = body as { prompt?: unknown; mcpEnabled?: unknown; skillsEnabled?: unknown };
  if (typeof raw.prompt !== 'string') throw new HttpError(400, 'prompt must be a string');
  const parsed: ParsedRoleBody = {
    prompt: truncateUtf8(raw.prompt.trim(), ROLE_PROMPT_MAX_BYTES),
  };
  if (raw.mcpEnabled !== undefined) parsed.mcpEnabled = parseWhitelist(raw.mcpEnabled, 'mcpEnabled');
  if (raw.skillsEnabled !== undefined) {
    parsed.skillsEnabled = parseWhitelist(raw.skillsEnabled, 'skillsEnabled');
  }
  return parsed;
}

function parseWhitelist(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new HttpError(400, `${field} must be a string array or null`);
  }
  return value;
}
