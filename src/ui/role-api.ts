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
  ROLE_PROMPT_MAX_BYTES,
  truncateUtf8,
  type AgentKind,
  type RoleConfig,
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
  /** Phase 2: how far MCP / skill scope can be controlled per bridge. */
  capabilities: { mcp: RoleScopeCapability; skills: RoleScopeCapability };
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
  const role = parseRoleBody(body);
  try {
    await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) throw new Error('config file not found');
      const profile = root.profiles[state.profile];
      if (!profile) throw new HttpError(404, `profile not found: ${state.profile}`);
      const next = { ...profile };
      const existing = profile.role;
      const preserved = existing
        ? {
            ...(existing.mcpEnabled ? { mcpEnabled: existing.mcpEnabled } : {}),
            ...(existing.skillsEnabled ? { skillsEnabled: existing.skillsEnabled } : {}),
          }
        : {};
      const merged: RoleConfig | undefined = role
        ? { ...preserved, prompt: role.prompt }
        : Object.keys(preserved).length > 0
          ? { prompt: '', ...preserved }
          : undefined;
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

/** Parse `{ prompt }`; blank prompt means "remove the role". */
function parseRoleBody(body: unknown): RoleConfig | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  const raw = body as { prompt?: unknown };
  if (typeof raw.prompt !== 'string') {
    throw new HttpError(400, 'prompt must be a string');
  }
  const prompt = truncateUtf8(raw.prompt.trim(), ROLE_PROMPT_MAX_BYTES);
  return prompt ? { prompt } : undefined;
}
