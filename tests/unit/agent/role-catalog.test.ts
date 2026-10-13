import { describe, expect, it } from 'vitest';
import { roleScope } from '../../../src/agent/role-catalog';

describe('roleScope', () => {
  it('reports per-agent MCP / skill control levels', () => {
    expect(roleScope('claude')).toEqual({ mcp: 'control', skills: 'readonly' });
    expect(roleScope('codex')).toEqual({ mcp: 'readonly', skills: 'none' });
    expect(roleScope('opencode')).toEqual({ mcp: 'control', skills: 'control' });
  });

  it('returns a fresh object so callers cannot mutate the table', () => {
    const a = roleScope('claude');
    a.mcp = 'none';
    expect(roleScope('claude').mcp).toBe('control');
  });
});
