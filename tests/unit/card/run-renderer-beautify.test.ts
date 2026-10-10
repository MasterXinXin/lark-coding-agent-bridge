import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

interface CardShape {
  header?: { title?: { content?: string }; template?: string };
  body?: { elements?: Array<Record<string, unknown>> };
}

describe('run card beautified renderer', () => {
  it('adds a stateful header', () => {
    const card = renderCard(initialState, { agentName: 'Coder' }) as CardShape;
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '🤖 Coder 正在思考' },
      template: 'blue',
    });

    const done = renderCard({ ...initialState, terminal: 'done', footer: null }, { agentName: 'Coder' }) as CardShape;
    expect(done.header?.template).toBe('green');
    expect(done.header?.title?.content).toBe('✅ Coder 已完成');
  });

  it('renders an elapsed/model/tool footer with a deterministic clock', () => {
    const state = stateFrom([
      { type: 'system', model: 'openai/gpt-5' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]);
    const card = renderCard(state, { agentName: 'Coder', startedAt: 1_000, now: 8_500 }) as CardShape;
    const dump = JSON.stringify(card.body?.elements ?? []);
    expect(dump).toContain('⏱ 7.5s');
    expect(dump).toContain('🔧 1 次工具');
    expect(dump).toContain('🧩 openai/gpt-5');
  });

  it('renders a usage footer only when usage is present', () => {
    const withUsage = stateFrom([
      { type: 'usage', inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, costUsd: 0.0123 },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const dump = JSON.stringify((renderCard(withUsage) as CardShape).body?.elements ?? []);
    expect(dump).toContain('↑ 120 ↓ 30');
    expect(dump).toContain('缓存 40');
    expect(dump).toContain('$0.0123');

    const noUsage = JSON.stringify((renderCard(initialState) as CardShape).body?.elements ?? []);
    expect(noUsage).not.toContain('缓存');
  });

  it('colors tool panels by tool type and red on error', () => {
    const running = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]);
    const bashPanel = findPanel(renderCard(running) as CardShape, 'Bash');
    expect(bashPanel?.border).toEqual({ color: 'orange', corner_radius: '5px' });

    const errored = stateFrom([
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x.ts' } },
      { type: 'tool_result', id: 't2', output: 'ENOENT', isError: true },
    ]);
    const readPanel = findPanel(renderCard(errored) as CardShape, 'Read');
    expect(readPanel?.border).toEqual({ color: 'red', corner_radius: '5px' });
  });
});

function findPanel(card: CardShape, name: string): Record<string, unknown> | undefined {
  return (card.body?.elements ?? []).find((element) => {
    const header = element.header as { title?: { content?: string } } | undefined;
    return header?.title?.content?.includes(name);
  });
}
