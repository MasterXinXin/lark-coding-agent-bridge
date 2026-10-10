import { describe, expect, it } from 'vitest';
import {
  CARD_SPINNER_FRAMES,
  cardHeader,
  spinnerFrame,
  toolBorderColor,
} from '../../../src/card/theme.js';
import { initialState, type RunState, type ToolEntry } from '../../../src/card/run-state.js';

const FIXED_NOW = 0; // frame index 0 -> '⠋'

function tool(name: string, status: ToolEntry['status'] = 'done'): ToolEntry {
  return { id: 't', name, input: {}, status };
}

describe('card theme', () => {
  it('maps running footer states to header templates and titles', () => {
    expect(cardHeader({ ...initialState, footer: 'thinking' }, 'Coder', FIXED_NOW)).toEqual({
      template: 'blue',
      title: '⠋ Coder 正在思考',
    });
    expect(cardHeader({ ...initialState, footer: 'tool_running' }, 'Coder', FIXED_NOW)).toEqual({
      template: 'wathet',
      title: '⠋ Coder 正在调用工具',
    });
    expect(cardHeader({ ...initialState, footer: 'streaming' }, 'Coder', FIXED_NOW)).toEqual({
      template: 'indigo',
      title: '⠋ Coder 正在回复',
    });
  });

  it('maps terminal states to header templates and titles without a spinner', () => {
    const done: RunState = { ...initialState, terminal: 'done', footer: null };
    expect(cardHeader(done, 'Coder', FIXED_NOW)).toEqual({ template: 'green', title: '✅ Coder 已完成' });

    const errored: RunState = { ...initialState, terminal: 'error', footer: null };
    expect(cardHeader(errored, 'Coder', FIXED_NOW)).toEqual({ template: 'red', title: '⚠️ Coder 执行失败' });

    const interrupted: RunState = { ...initialState, terminal: 'interrupted', footer: null };
    expect(cardHeader(interrupted, 'Coder', FIXED_NOW)).toEqual({ template: 'grey', title: '⏹ Coder 已中断' });

    const timedOut: RunState = {
      ...initialState,
      terminal: 'idle_timeout',
      footer: null,
      idleTimeoutMinutes: 15,
    };
    expect(cardHeader(timedOut, 'Coder', FIXED_NOW)).toEqual({
      template: 'orange',
      title: '⏱ Coder 已超时（15 分钟无响应）',
    });
  });

  it('advances and wraps the braille spinner frame over wall-clock time', () => {
    expect(CARD_SPINNER_FRAMES).toHaveLength(10);
    expect(spinnerFrame(0)).toBe('⠋');
    expect(spinnerFrame(500)).toBe('⠙');
    expect(spinnerFrame(4_500)).toBe('⠏');
    expect(spinnerFrame(5_000)).toBe('⠋');
  });

  it('falls back to a generic agent name', () => {
    expect(cardHeader(initialState, undefined, FIXED_NOW).title).toBe('⠋ Agent 正在思考');
  });

  it('maps tool names to border colors, with errors overriding to red', () => {
    expect(toolBorderColor(tool('Bash'))).toBe('orange');
    expect(toolBorderColor(tool('read'))).toBe('blue');
    expect(toolBorderColor(tool('Edit'))).toBe('blue');
    expect(toolBorderColor(tool('Grep'))).toBe('turquoise');
    expect(toolBorderColor(tool('WebFetch'))).toBe('wathet');
    expect(toolBorderColor(tool('Task'))).toBe('purple');
    expect(toolBorderColor(tool('Skill'))).toBe('violet');
    expect(toolBorderColor(tool('SomethingElse'))).toBe('grey');
    expect(toolBorderColor(tool('Bash', 'error'))).toBe('red');
  });
});
