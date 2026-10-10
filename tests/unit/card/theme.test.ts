import { describe, expect, it } from 'vitest';
import { cardHeader, toolBorderColor } from '../../../src/card/theme.js';
import { initialState, type RunState, type ToolEntry } from '../../../src/card/run-state.js';

function tool(name: string, status: ToolEntry['status'] = 'done'): ToolEntry {
  return { id: 't', name, input: {}, status };
}

describe('card theme', () => {
  it('maps running footer states to header templates and titles', () => {
    expect(cardHeader({ ...initialState, footer: 'thinking' }, 'Coder')).toEqual({
      template: 'blue',
      title: '🤖 Coder 正在思考',
    });
    expect(cardHeader({ ...initialState, footer: 'tool_running' }, 'Coder')).toEqual({
      template: 'wathet',
      title: '🤖 Coder 正在调用工具',
    });
    expect(cardHeader({ ...initialState, footer: 'streaming' }, 'Coder')).toEqual({
      template: 'indigo',
      title: '🤖 Coder 正在回复',
    });
  });

  it('maps terminal states to header templates and titles', () => {
    const done: RunState = { ...initialState, terminal: 'done', footer: null };
    expect(cardHeader(done, 'Coder')).toEqual({ template: 'green', title: '✅ Coder 已完成' });

    const errored: RunState = { ...initialState, terminal: 'error', footer: null };
    expect(cardHeader(errored, 'Coder')).toEqual({ template: 'red', title: '⚠️ Coder 执行失败' });

    const interrupted: RunState = { ...initialState, terminal: 'interrupted', footer: null };
    expect(cardHeader(interrupted, 'Coder')).toEqual({ template: 'grey', title: '⏹ Coder 已中断' });

    const timedOut: RunState = {
      ...initialState,
      terminal: 'idle_timeout',
      footer: null,
      idleTimeoutMinutes: 15,
    };
    expect(cardHeader(timedOut, 'Coder')).toEqual({
      template: 'orange',
      title: '⏱ Coder 已超时（15 分钟无响应）',
    });
  });

  it('falls back to a generic agent name', () => {
    expect(cardHeader(initialState).title).toBe('🤖 Agent 正在思考');
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
