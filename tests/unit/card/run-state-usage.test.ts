import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state.js';

describe('run state model and usage', () => {
  it('records the model from a system event', () => {
    const state = reduce(initialState, { type: 'system', model: 'openai/gpt-5' });
    expect(state.model).toBe('openai/gpt-5');
  });

  it('ignores a system event without a model', () => {
    const state = reduce(initialState, { type: 'system', sessionId: 'ses_1' });
    expect(state.model).toBeUndefined();
  });

  it('accumulates usage across events', () => {
    let state = reduce(initialState, {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    });
    state = reduce(state, {
      type: 'usage',
      inputTokens: 50,
      cachedInputTokens: 30,
      costUsd: 0.02,
    });
    expect(state.usage).toEqual({
      inputTokens: 150,
      outputTokens: 20,
      cachedInputTokens: 30,
      costUsd: 0.03,
    });
  });

  it('keeps usage undefined when no usage event arrives', () => {
    expect(initialState.usage).toBeUndefined();
  });

  it('accumulates reasoning tokens too', () => {
    const state = reduce(initialState, { type: 'usage', reasoningOutputTokens: 7 });
    expect(state.usage).toEqual({ reasoningOutputTokens: 7 });
  });

  it('ignores malformed (non-finite / non-number) usage values', () => {
    const state = reduce(initialState, {
      type: 'usage',
      inputTokens: Number.NaN,
      outputTokens: '5' as unknown as number,
      costUsd: null as unknown as number,
    });
    expect(state.usage).toEqual({});
  });

  it('does not mutate the previous usage object', () => {
    const prev = reduce(initialState, { type: 'usage', inputTokens: 10 });
    const snapshot = { ...prev.usage };
    const next = reduce(prev, { type: 'usage', inputTokens: 5 });
    expect(prev.usage).toEqual(snapshot);
    expect(next.usage).toEqual({ inputTokens: 15 });
  });

  it('keeps the same state reference for a model-less system event', () => {
    expect(reduce(initialState, { type: 'system', sessionId: 'ses_1' })).toBe(initialState);
  });
});
