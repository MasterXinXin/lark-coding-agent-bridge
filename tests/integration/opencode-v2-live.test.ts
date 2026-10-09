import { describe, expect, it } from 'vitest';

import type { NormalizedEvent } from '../../src/agent/opencode/events';
import { OpencodeServer } from '../../src/agent/opencode/server';
import { OpencodeV2Client } from '../../src/agent/opencode/transport-v2';

/**
 * Opt-in live test against a real `opencode serve` (v2). Skipped unless
 * `LARK_CHANNEL_OPENCODE_LIVE=1`. Point `LARK_CHANNEL_OPENCODE_BIN` at the
 * opencode CLI when it is not spawnable as `opencode` (e.g. a `.cmd` shim).
 *
 * This exercises the whole v2 transport: spawn with a generated
 * `OPENCODE_SERVER_PASSWORD`, Basic-auth readiness, session create, prompt, and
 * event-stream normalization through to a terminal `status: idle` (or `error`).
 */
const LIVE = process.env.LARK_CHANNEL_OPENCODE_LIVE === '1';
const BIN = process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
const PORT = Number(process.env.LARK_CHANNEL_OPENCODE_LIVE_PORT ?? 4517);

describe.skipIf(!LIVE)('opencode v2 live', () => {
  it(
    'spawns serve, creates + prompts a session, and streams to a terminal status',
    async () => {
      const server = new OpencodeServer({
        port: PORT,
        host: '127.0.0.1',
        opencodePath: BIN,
        apiVersion: 2,
        readyTimeoutMs: 30_000,
      });
      // Mirror the adapter: build the client before start(), resolving baseUrl
      // lazily (v2 may fall back to a free port when PORT is occupied).
      const client = new OpencodeV2Client({
        baseUrl: () => server.baseUrl,
        authHeader: server.authHeader,
      });
      await server.start();
      expect(server.authHeader).toMatch(/^Basic /);

      try {
        const info = await client.createSession('bridge e2e', process.cwd());
        expect(info.id).toBeTruthy();

        // The "/config cleared → follow opencode default" path leans on the SDK
        // exposing `model.default`; verify it exists and returns a real model.
        const { OpenCode } = await import('@opencode/client');
        const sdk = OpenCode.make({
          baseUrl: server.baseUrl,
          headers: { authorization: server.authHeader },
        }) as unknown as {
          model: {
            default: (
              input?: unknown,
            ) => Promise<{ data?: { id?: string; providerID?: string } | null }>;
          };
        };
        const def = await sdk.model.default({ location: { directory: process.cwd() } });
        expect(def?.data?.id).toBeTruthy();
        expect(def?.data?.providerID).toBeTruthy();

        const stream = client.createEventStream({});
        const seen: NormalizedEvent[] = [];
        let terminal = false;
        stream.on('event', (event) => {
          const normalized = event as NormalizedEvent;
          seen.push(normalized);
          if (normalized.kind === 'status' && normalized.status === 'idle') terminal = true;
          if (normalized.kind === 'error') terminal = true;
        });
        await stream.start();

        await client.promptAsync({
          sessionId: info.id,
          parts: [{ type: 'text', text: 'Reply with exactly the word OK and nothing else.' }],
          system: 'You are terse.',
          ...(process.env.LARK_CHANNEL_OPENCODE_LIVE_MODEL
            ? { model: process.env.LARK_CHANNEL_OPENCODE_LIVE_MODEL }
            : {}),
        });

        const deadline = Date.now() + 90_000;
        while (!terminal && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        stream.close();

        // eslint-disable-next-line no-console
        console.log('LIVE v2 events:', JSON.stringify(seen.slice(-40), null, 2));

        expect(seen.some((event) => event.kind === 'connected')).toBe(true);
        expect(seen.length).toBeGreaterThan(1);
        expect(terminal).toBe(true);
      } finally {
        server.stop();
      }
    },
    150_000,
  );
});
