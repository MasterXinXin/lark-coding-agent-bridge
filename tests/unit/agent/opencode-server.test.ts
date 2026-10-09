import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { pickFreePort } from '../../../src/agent/opencode/server';

function listenEphemeral(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

describe('pickFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    const { server, port } = await listenEphemeral();
    await close(server);
    expect(await pickFreePort('127.0.0.1', port)).toBe(port);
  });

  it('falls back to a different, bindable port when the preferred one is taken', async () => {
    const held = await listenEphemeral();
    try {
      const picked = await pickFreePort('127.0.0.1', held.port);
      expect(picked).not.toBe(held.port);
      expect(picked).toBeGreaterThan(0);
      expect(await canBind(picked)).toBe(true);
    } finally {
      await close(held.server);
    }
  });
});
