import { describe, expect, it } from 'vitest';

import type { NormalizedEvent } from '../../../src/agent/opencode/events';
import { OpencodeV2Client, parseModelV2 } from '../../../src/agent/opencode/transport-v2';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Calls {
  create: any[];
  prompt: any[];
  interrupt: any[];
  switchModel: any[];
  switchAgent: any[];
  modelDefault: any[];
  reply: any[];
}

interface FakeSdk {
  sdk: any;
  calls: Calls;
  push: (event: unknown) => void;
  finish: () => void;
  setDefaultModel: (data: { id: string; providerID: string } | null) => void;
}

/**
 * Minimal in-memory stand-in for `@opencode/client`. `event.subscribe()`
 * returns an AsyncIterable the test drives via `push()`/`finish()`.
 */
function makeFakeSdk(): FakeSdk {
  const calls: Calls = {
    create: [],
    prompt: [],
    interrupt: [],
    switchModel: [],
    switchAgent: [],
    modelDefault: [],
    reply: [],
  };
  let pushEvent: ((event: unknown) => void) | null = null;
  let finishStream: (() => void) | null = null;
  let defaultModelData: { id: string; providerID: string } | null = {
    id: 'def-model',
    providerID: 'def-prov',
  };

  const events: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      const queue: unknown[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      pushEvent = (event) => {
        queue.push(event);
        wake?.();
        wake = null;
      };
      finishStream = () => {
        done = true;
        wake?.();
        wake = null;
      };
      return {
        async next() {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        },
        async return() {
          done = true;
          return { value: undefined, done: true };
        },
      };
    },
  };

  const sdk = {
    session: {
      create: async (input: unknown) => {
        calls.create.push(input);
        return { id: 'ses_v2', title: 'T' };
      },
      prompt: async (input: unknown) => {
        calls.prompt.push(input);
        return {};
      },
      interrupt: async (input: unknown) => {
        calls.interrupt.push(input);
        return {};
      },
      switchModel: async (input: unknown) => {
        calls.switchModel.push(input);
        return {};
      },
      switchAgent: async (input: unknown) => {
        calls.switchAgent.push(input);
        return {};
      },
    },
    model: {
      default: async (input: unknown) => {
        calls.modelDefault.push(input);
        return { data: defaultModelData };
      },
    },
    permission: {
      reply: async (input: unknown) => {
        calls.reply.push(input);
        return {};
      },
    },
    event: { subscribe: () => events },
  };

  return {
    sdk,
    calls,
    push: (event) => pushEvent?.(event),
    finish: () => finishStream?.(),
    setDefaultModel: (data) => {
      defaultModelData = data;
    },
  };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(fake: FakeSdk, extra: Record<string, unknown> = {}): OpencodeV2Client {
  return new OpencodeV2Client({
    baseUrl: 'http://127.0.0.1:1',
    sdkFactory: async () => fake.sdk,
    ...extra,
  });
}

describe('parseModelV2', () => {
  it('splits providerID/modelID into v2 shape', () => {
    expect(parseModelV2('opencode-go/deepseek-v4-flash')).toEqual({
      providerID: 'opencode-go',
      id: 'deepseek-v4-flash',
    });
  });

  it('rejects malformed model ids', () => {
    expect(() => parseModelV2('no-slash')).toThrow();
    expect(() => parseModelV2('/leading')).toThrow();
    expect(() => parseModelV2('trailing/')).toThrow();
  });
});

describe('OpencodeV2Client', () => {
  it('createSession forwards title + location and returns a SessionInfo', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    const info = await client.createSession('My title', 'D:/repo');
    expect(info).toEqual({ id: 'ses_v2', title: 'T', directory: 'D:/repo' });
    expect(fake.calls.create[0]).toEqual({
      title: 'My title',
      location: { directory: 'D:/repo' },
    });
  });

  it('promptAsync switches model/agent once then prepends the system prompt', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    await client.promptAsync({
      sessionId: 's',
      parts: [{ type: 'text', text: 'hi' }],
      system: 'SYS',
      model: 'opencode-go/deepseek-v4-flash',
      agent: 'build',
    });
    expect(fake.calls.switchModel[0]).toEqual({
      sessionID: 's',
      model: { providerID: 'opencode-go', id: 'deepseek-v4-flash' },
    });
    expect(fake.calls.switchAgent[0]).toEqual({ sessionID: 's', agent: 'build' });
    expect(fake.calls.prompt[0]).toEqual({ sessionID: 's', text: 'SYS\n\nhi' });

    // Second turn with the same model/agent must not re-issue switches.
    await client.promptAsync({
      sessionId: 's',
      parts: [{ type: 'text', text: 'again' }],
      model: 'opencode-go/deepseek-v4-flash',
      agent: 'build',
    });
    expect(fake.calls.switchModel).toHaveLength(1);
    expect(fake.calls.switchAgent).toHaveLength(1);
    expect(fake.calls.prompt[1]).toEqual({ sessionID: 's', text: 'again' });
  });

  it('falls back to the default model and omits agent when unset', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake, { defaultModel: 'p/m' });
    await client.promptAsync({ sessionId: 's', parts: [{ type: 'text', text: 'x' }] });
    expect(fake.calls.switchModel[0]).toEqual({
      sessionID: 's',
      model: { providerID: 'p', id: 'm' },
    });
    expect(fake.calls.switchAgent).toHaveLength(0);
  });

  it('switches model mid-session when /config changes', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    await client.promptAsync({
      sessionId: 's',
      parts: [{ type: 'text', text: 'a' }],
      model: 'p/first',
    });
    await client.promptAsync({
      sessionId: 's',
      parts: [{ type: 'text', text: 'b' }],
      model: 'p/second',
    });
    expect(fake.calls.switchModel).toEqual([
      { sessionID: 's', model: { providerID: 'p', id: 'first' } },
      { sessionID: 's', model: { providerID: 'p', id: 'second' } },
    ]);
  });

  it('switches back to opencode default when /config is cleared mid-session', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    await client.createSession('t', 'D:/repo');
    await client.promptAsync({
      sessionId: 'ses_v2',
      parts: [{ type: 'text', text: 'a' }],
      model: 'p/explicit',
    });
    // Now clear it: the session must be actively switched back to opencode's
    // (directory-scoped) default, not left on the explicit model.
    await client.promptAsync({ sessionId: 'ses_v2', parts: [{ type: 'text', text: 'b' }] });
    expect(fake.calls.switchModel).toHaveLength(2);
    expect(fake.calls.switchModel[1]).toEqual({
      sessionID: 'ses_v2',
      model: { providerID: 'def-prov', id: 'def-model' },
    });
    expect(fake.calls.modelDefault[0]).toEqual({ location: { directory: 'D:/repo' } });

    // Subsequent default turns must not re-resolve or re-switch.
    await client.promptAsync({ sessionId: 'ses_v2', parts: [{ type: 'text', text: 'c' }] });
    expect(fake.calls.switchModel).toHaveLength(2);
    expect(fake.calls.modelDefault).toHaveLength(1);
  });

  it('does not touch model.default when no model was ever applied', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    await client.promptAsync({ sessionId: 's', parts: [{ type: 'text', text: 'x' }] });
    expect(fake.calls.modelDefault).toHaveLength(0);
    expect(fake.calls.switchModel).toHaveLength(0);
  });

  it('leaves the session on its model when opencode exposes no default', async () => {
    const fake = makeFakeSdk();
    fake.setDefaultModel(null);
    const client = makeClient(fake);
    await client.promptAsync({
      sessionId: 's',
      parts: [{ type: 'text', text: 'a' }],
      model: 'p/explicit',
    });
    await expect(
      client.promptAsync({ sessionId: 's', parts: [{ type: 'text', text: 'b' }] }),
    ).resolves.toBeUndefined();
    // Only the initial explicit switch happened; revert was skipped.
    expect(fake.calls.switchModel).toHaveLength(1);
  });

  it('abortSession interrupts and swallows failures', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    await client.abortSession('s');
    expect(fake.calls.interrupt[0]).toEqual({ sessionID: 's' });

    const failing = makeFakeSdk();
    failing.sdk.session.interrupt = async () => {
      throw new Error('nope');
    };
    const client2 = makeClient(failing);
    await expect(client2.abortSession('s')).resolves.toBeUndefined();
  });

  it('learns the permission sessionID from the event stream so replyPermission can target it', async () => {
    const fake = makeFakeSdk();
    const client = makeClient(fake);
    const stream = client.createEventStream({});
    const seen: NormalizedEvent[] = [];
    stream.on('event', (event) => seen.push(event as NormalizedEvent));
    await stream.start();
    expect(seen[0]).toEqual({ kind: 'connected' });

    fake.push({
      type: 'permission.asked',
      data: { id: 'perm_9', sessionID: 'ses_9', action: 'bash', resources: ['x'] },
    });
    await tick();
    expect(seen.some((event) => event.kind === 'permission')).toBe(true);

    await client.replyPermission('perm_9', 'once');
    expect(fake.calls.reply[0]).toEqual({
      sessionID: 'ses_9',
      requestID: 'perm_9',
      decision: 'once',
    });

    stream.close();
    fake.finish();
  });
});
