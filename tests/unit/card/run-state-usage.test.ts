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
});
