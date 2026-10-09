import type { NormalizedEvent } from './events';

/**
 * v2 event envelopes are typed `{ type, created, id, location?, data }`. We
 * read them defensively (they cross a process boundary) rather than importing
 * the SDK's generated types, so a server/SDK version bump can't break the
 * bridge's typecheck.
 */
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function pickString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec || !(key in rec)) return undefined;
    cur = rec[key];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Concatenate the text segments of a v2 tool-result `content` array. */
function extractToolText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const segments: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    const text = typeof rec?.text === 'string' ? rec.text : undefined;
    if (text !== undefined) segments.push(text);
  }
  return segments.length > 0 ? segments.join('') : undefined;
}

/**
 * Build a stateful v2 → `NormalizedEvent` normalizer. Stateful because v2
 * splits a tool call across `session.tool.input.started` (which carries the
 * tool *name*) and `session.tool.called/success/failed` (which carry the
 * input/output but not the name). We cache `toolId → name` as events stream
 * in so the translated `tool_use` gets a real name.
 *
 * Returns `null` for events the bridge does not surface (MCP/plugin/config
 * updates, most housekeeping), matching the "normalized events only" contract
 * the v1 path established.
 */
export function createV2EventNormalizer(): (event: unknown) => NormalizedEvent | null {
  const toolNames = new Map<string, string>();

  return function normalizeV2Event(event: unknown): NormalizedEvent | null {
    const env = asRecord(event);
    const type = pickString(env, ['type']);
    if (!env || !type) return null;

    if (type === 'server.connected') return { kind: 'connected' };

    const data = asRecord(env.data) ?? {};
    const sessionID = pickString(data, ['sessionID']);

    switch (type) {
      // --- user / assistant message boundaries -------------------------------
      case 'session.inbox.enqueued':
      case 'session.inbox.delivered': {
        if (!sessionID) return null;
        const itemType = pickString(data, ['item', 'type']) ?? 'user';
        if (itemType !== 'user') return null;
        const messageID = pickString(data, ['inboxID']) ?? pickString(data, ['item', 'id']);
        if (!messageID) return null;
        return { kind: 'message', sessionID, messageID, role: 'user' };
      }
      case 'session.step.started': {
        if (!sessionID) return null;
        const messageID = pickString(data, ['assistantMessageID']);
        if (!messageID) return null;
        return { kind: 'message', sessionID, messageID, role: 'assistant' };
      }

      // --- streamed text / reasoning ----------------------------------------
      case 'session.text.delta': {
        if (!sessionID) return null;
        const messageID = pickString(data, ['assistantMessageID']);
        const delta = pickString(data, ['delta']);
        if (!messageID || delta === undefined) return null;
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID: `text:${messageID}`,
          partType: 'text',
          delta,
        };
      }
      case 'session.reasoning.delta': {
        if (!sessionID) return null;
        const messageID = pickString(data, ['assistantMessageID']);
        const delta = pickString(data, ['delta']);
        if (!messageID || delta === undefined) return null;
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID: `reasoning:${messageID}`,
          partType: 'reasoning',
          delta,
        };
      }

      // --- tool lifecycle ----------------------------------------------------
      case 'session.tool.input.started': {
        if (!sessionID) return null;
        const partID = pickString(data, ['id']);
        const messageID = pickString(data, ['assistantMessageID']);
        if (!partID || !messageID) return null;
        const name = pickString(data, ['name']);
        if (name) toolNames.set(partID, name);
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID,
          partType: 'tool',
          toolName: name ?? 'tool',
          toolState: 'pending',
          toolInput: {},
        };
      }
      case 'session.tool.called': {
        if (!sessionID) return null;
        const partID = pickString(data, ['id']);
        const messageID = pickString(data, ['assistantMessageID']);
        if (!partID || !messageID) return null;
        const input = asRecord(data.input);
        const title = pickString(data, ['state', 'title']) ?? pickString(data, ['metadata', 'title']);
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID,
          partType: 'tool',
          toolName: toolNames.get(partID) ?? 'tool',
          toolState: 'running',
          ...(input ? { toolInput: input } : {}),
          ...(title !== undefined ? { toolTitle: title } : {}),
        };
      }
      case 'session.tool.success': {
        if (!sessionID) return null;
        const partID = pickString(data, ['id']);
        const messageID = pickString(data, ['assistantMessageID']);
        if (!partID || !messageID) return null;
        const output = extractToolText(data.content);
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID,
          partType: 'tool',
          toolName: toolNames.get(partID) ?? 'tool',
          toolState: 'completed',
          ...(output !== undefined ? { toolOutput: output } : {}),
        };
      }
      case 'session.tool.failed': {
        if (!sessionID) return null;
        const partID = pickString(data, ['id']);
        const messageID = pickString(data, ['assistantMessageID']);
        if (!partID || !messageID) return null;
        const message =
          pickString(data, ['error', 'message']) ??
          pickString(data, ['error']) ??
          extractToolText(data.content) ??
          'tool failed';
        return {
          kind: 'part',
          sessionID,
          messageID,
          partID,
          partType: 'tool',
          toolName: toolNames.get(partID) ?? 'tool',
          toolState: 'error',
          toolOutput: message,
        };
      }

      // --- completion / status / errors -------------------------------------
      case 'session.idle': {
        if (!sessionID) return null;
        return { kind: 'status', sessionID, status: 'idle' };
      }
      case 'session.status': {
        if (!sessionID) return null;
        const status =
          typeof data.status === 'string'
            ? data.status
            : pickString(data, ['status', 'type']);
        if (!status) return null;
        return { kind: 'status', sessionID, status };
      }
      case 'session.execution.failed': {
        if (!sessionID) return null;
        const message =
          pickString(data, ['error', 'message']) ??
          pickString(data, ['error']) ??
          'opencode run failed';
        return { kind: 'error', sessionID, message };
      }
      // opencode v2.0.x terminates a turn with the `session.execution.*`
      // family rather than `session.idle` (which newer schema builds emit).
      // Without mapping `succeeded` to idle, a successfully-finished run
      // never delivers a terminal event and the bridge hangs forever.
      case 'session.execution.succeeded': {
        if (!sessionID) return null;
        return { kind: 'status', sessionID, status: 'idle' };
      }
      case 'session.execution.interrupted': {
        if (!sessionID) return null;
        return { kind: 'status', sessionID, status: 'interrupted' };
      }

      // --- permission --------------------------------------------------------
      case 'permission.asked': {
        if (!sessionID) return null;
        const requestID = pickString(data, ['id']);
        if (!requestID) return null;
        const tool = pickString(data, ['action']) ?? 'tool';
        const resources = Array.isArray(data.resources) ? data.resources : undefined;
        const description = pickString(data, ['message']);
        return {
          kind: 'permission',
          sessionID,
          requestID,
          tool,
          ...(resources ? { input: { resources } } : {}),
          ...(description !== undefined ? { description } : {}),
        };
      }

      default:
        return null;
    }
  };
}
