import { describe, expect, it } from 'vitest';

import {
  buildOpencodeRoleConfig,
  buildOpencodeV1RoleConfig,
  buildOpencodeV2RoleConfig,
} from '../../../src/agent/opencode/role-config';

const KNOWN = ['chrome-devtools', 'context7', 'codegraph'];
const KNOWN_SKILLS = ['git-release', 'deploy'];

describe('buildOpencodeV2RoleConfig', () => {
  it('injects nothing when the whitelist is undefined (follow native)', () => {
    const out = buildOpencodeV2RoleConfig({ knownMcp: KNOWN, knownSkills: KNOWN_SKILLS });
    expect(out.config).toBeUndefined();
    expect(out.deniedMcp).toEqual([]);
    expect(out.deniedSkills).toEqual([]);
  });

  it('denies every known MCP server when the whitelist is an explicit empty array', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: [],
      knownMcp: KNOWN,
      knownSkills: [],
    });
    expect(out.deniedMcp).toEqual(KNOWN);
    expect(out.config).toEqual({
      permissions: [
        { action: 'chrome-devtools_*', resource: '*', effect: 'deny' },
        { action: 'context7_*', resource: '*', effect: 'deny' },
        { action: 'codegraph_*', resource: '*', effect: 'deny' },
      ],
    });
  });

  it('denies only the servers outside an explicit allow-list', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: ['context7'],
      knownMcp: KNOWN,
      knownSkills: [],
    });
    expect(out.deniedMcp).toEqual(['chrome-devtools', 'codegraph']);
    expect(out.config).toEqual({
      permissions: [
        { action: 'chrome-devtools_*', resource: '*', effect: 'deny' },
        { action: 'codegraph_*', resource: '*', effect: 'deny' },
      ],
    });
  });

  it('denies non-whitelisted skills by id', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: [],
      skillsEnabled: ['deploy'],
      knownMcp: [],
      knownSkills: KNOWN_SKILLS,
    });
    expect(out.deniedSkills).toEqual(['git-release']);
    expect(out.config).toEqual({
      permissions: [{ action: 'skill', resource: 'git-release', effect: 'deny' }],
    });
  });

  it('ignores whitelist names that are not in the known set', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: ['not-a-real-server'],
      knownMcp: KNOWN,
      knownSkills: [],
    });
    expect(out.deniedMcp).toEqual(KNOWN);
    expect(out.config).toEqual({
      permissions: KNOWN.map((name) => ({ action: `${name}_*`, resource: '*', effect: 'deny' })),
    });
  });

  it('de-duplicates known names', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: [],
      knownMcp: ['a', 'a', 'b'],
      knownSkills: [],
    });
    expect(out.deniedMcp).toEqual(['a', 'b']);
  });

  it('produces no config when nothing known can be denied', () => {
    const out = buildOpencodeV2RoleConfig({ mcpEnabled: [], knownMcp: [], knownSkills: [] });
    expect(out.config).toBeUndefined();
  });

  it('normalizes unsupported characters to `_` in the MCP action namespace', () => {
    const out = buildOpencodeV2RoleConfig({
      mcpEnabled: [],
      knownMcp: ['my.server', 'weird name'],
      knownSkills: [],
    });
    expect(out.deniedMcp).toEqual(['my.server', 'weird name']);
    expect(out.config).toEqual({
      permissions: [
        { action: 'my_server_*', resource: '*', effect: 'deny' },
        { action: 'weird_name_*', resource: '*', effect: 'deny' },
      ],
    });
  });
});

describe('buildOpencodeV1RoleConfig', () => {
  it('emits mcp.<name>.enabled=false for denied servers', () => {
    const out = buildOpencodeV1RoleConfig({
      mcpEnabled: ['context7'],
      knownMcp: KNOWN,
      knownSkills: KNOWN_SKILLS,
    });
    expect(out.config).toEqual({
      mcp: { 'chrome-devtools': { enabled: false }, codegraph: { enabled: false } },
    });
  });

  it('injects nothing when unrestricted', () => {
    expect(buildOpencodeV1RoleConfig({ knownMcp: KNOWN, knownSkills: [] }).config).toBeUndefined();
  });

  it('ignores skills (v1 has no skill config) but still reports deniedSkills', () => {
    const out = buildOpencodeV1RoleConfig({
      mcpEnabled: ['context7'],
      skillsEnabled: ['deploy'],
      knownMcp: KNOWN,
      knownSkills: KNOWN_SKILLS,
    });
    expect(out.config).toEqual({
      mcp: { 'chrome-devtools': { enabled: false }, codegraph: { enabled: false } },
    });
    expect(out.deniedSkills).toEqual(['git-release']);
  });
});

describe('buildOpencodeRoleConfig', () => {
  it('dispatches by API version', () => {
    const input = { mcpEnabled: ['context7'] as string[], knownMcp: KNOWN, knownSkills: [] };
    expect(buildOpencodeRoleConfig(2, input).config).toEqual({
      permissions: [
        { action: 'chrome-devtools_*', resource: '*', effect: 'deny' },
        { action: 'codegraph_*', resource: '*', effect: 'deny' },
      ],
    });
    expect(buildOpencodeRoleConfig(1, input).config).toEqual({
      mcp: { 'chrome-devtools': { enabled: false }, codegraph: { enabled: false } },
    });
  });
});
