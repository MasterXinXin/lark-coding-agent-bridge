import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows a red notice with the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    const json = JSON.stringify(card);
    expect(json).toContain(url);
    expect(json).toContain('Web 控制台');
    expect(json).toContain("font color='red'");
    expect(json).toContain('工作空间');
  });

  it('keeps the red workspace notice (without a URL) when no console is running', () => {
    const card = configFormCard(base);
    const json = JSON.stringify(card);
    expect(json).not.toContain('Web 控制台');
    expect(json).toContain("font color='red'");
    expect(json).toContain('工作空间');
  });
});
