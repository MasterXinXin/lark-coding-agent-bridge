import { describe, expect, it } from 'vitest';

import { createV2EventNormalizer } from '../../../src/agent/opencode/events-v2';

const normalize = createV2EventNormalizer();

describe('normalizeV2Event', () => {
  it('maps server.connected to a connected event', () => {
    expect(normalize({ type: 'server.connected', data: {} })).toEqual({ kind: 'connected' });
  });

  it('drops housekeeping events', () => {
    expect(normalize({ type: 'mcp.status.changed', data: { server: 'x' } })).toBeNull();
    expect(normalize({ type: 'plugin.updated', data: {} })).toBeNull();
    expect(normalize({})).toBeNull();
    expect(normalize(null)).toBeNull();
  });

  it('maps user inbox items to user messages and step.started to assistant messages', () => {
    expect(
      normalize({
        type: 'session.inbox.enqueued',
        data: {
          sessionID: 'ses_1',
          inboxID: 'msg_user',
          item: { type: 'user', payload: { text: 'hi' }, delivery: 'steer' },
        },
      }),
    ).toEqual({ kind: 'message', sessionID: 'ses_1', messageID: 'msg_user', role: 'user' });

    expect(
      normalize({
        type: 'session.step.started',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_asst', agent: 'build' },
      }),
    ).toEqual({ kind: 'message', sessionID: 'ses_1', messageID: 'msg_asst', role: 'assistant' });
  });

  it('maps text and reasoning deltas to parts', () => {
    expect(
      normalize({
        type: 'session.text.delta',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, delta: 'Hello' },
      }),
    ).toEqual({
      kind: 'part',
      sessionID: 'ses_1',
      messageID: 'msg_a',
      partID: 'text:msg_a',
      partType: 'text',
      delta: 'Hello',
    });

    expect(
      normalize({
        type: 'session.reasoning.delta',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, delta: 'hmm' },
      }),
    ).toEqual({
      kind: 'part',
      sessionID: 'ses_1',
      messageID: 'msg_a',
      partID: 'reasoning:msg_a',
      partType: 'reasoning',
      delta: 'hmm',
    });
  });

  it('threads the tool name from input.started through the whole tool lifecycle', () => {
    // input.started carries the name; called/success do not — the normalizer caches it.
    expect(
      normalize({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'tool_1', name: 'read' },
      }),
    ).toEqual({
      kind: 'part',
      sessionID: 'ses_1',
      messageID: 'msg_a',
      partID: 'tool_1',
      partType: 'tool',
      toolName: 'read',
      toolState: 'pending',
      toolInput: {},
    });

    expect(
      normalize({
        type: 'session.tool.called',
        data: {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_a',
          id: 'tool_1',
          input: { filePath: 'package.json' },
          executed: false,
        },
      }),
    ).toEqual({
      kind: 'part',
      sessionID: 'ses_1',
      messageID: 'msg_a',
      partID: 'tool_1',
      partType: 'tool',
      toolName: 'read',
      toolState: 'running',
      toolInput: { filePath: 'package.json' },
    });

    expect(
      normalize({
        type: 'session.tool.success',
        data: {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_a',
          id: 'tool_1',
          executed: true,
          content: [{ type: 'text', text: '{"name":"x"}' }],
        },
      }),
    ).toEqual({
      kind: 'part',
      sessionID: 'ses_1',
      messageID: 'msg_a',
      partID: 'tool_1',
      partType: 'tool',
      toolName: 'read',
      toolState: 'completed',
      toolOutput: '{"name":"x"}',
    });
  });

  it('maps a failed tool call to an error part with the failure message', () => {
    const n = normalize({
      type: 'session.tool.failed',
      data: {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_a',
        id: 'tool_2',
        error: { message: 'ENOENT' },
      },
    });
    expect(n).toMatchObject({
      kind: 'part',
      partID: 'tool_2',
      partType: 'tool',
      toolState: 'error',
      toolOutput: 'ENOENT',
    });
  });

  it('maps idle/status/execution.failed', () => {
    expect(normalize({ type: 'session.idle', data: { sessionID: 'ses_1' } })).toEqual({
      kind: 'status',
      sessionID: 'ses_1',
      status: 'idle',
    });
    expect(
      normalize({ type: 'session.status', data: { sessionID: 'ses_1', status: { type: 'idle' } } }),
    ).toEqual({ kind: 'status', sessionID: 'ses_1', status: 'idle' });
    expect(
      normalize({
        type: 'session.execution.failed',
        data: { sessionID: 'ses_1', error: { message: 'provider auth failed' } },
      }),
    ).toEqual({ kind: 'error', sessionID: 'ses_1', message: 'provider auth failed' });
  });

  it('maps execution terminal events to status', () => {
    // opencode v2.0.18 does not emit `session.idle`; a successful turn ends
    // with `session.execution.succeeded`. Without this mapping the bridge's
    // run never observes a terminal event and hangs forever.
    expect(
      normalize({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }),
    ).toEqual({ kind: 'status', sessionID: 'ses_1', status: 'idle' });
    expect(
      normalize({ type: 'session.execution.interrupted', data: { sessionID: 'ses_1' } }),
    ).toEqual({ kind: 'status', sessionID: 'ses_1', status: 'interrupted' });
    expect(normalize({ type: 'session.execution.started', data: { sessionID: 'ses_1' } })).toBeNull();
  });

  it('maps permission.asked to a permission event carrying action + resources', () => {
    expect(
      normalize({
        type: 'permission.asked',
        data: {
          id: 'perm_1',
          sessionID: 'ses_1',
          action: 'bash',
          resources: ['rm -rf /tmp/x'],
          message: 'run a command',
        },
      }),
    ).toEqual({
      kind: 'permission',
      sessionID: 'ses_1',
      requestID: 'perm_1',
      tool: 'bash',
      input: { resources: ['rm -rf /tmp/x'] },
      description: 'run a command',
    });
  });
});
