import type { RunState, ToolEntry } from './run-state.js';

/**
 * Feishu card header templates are a fixed named palette — custom hex is not
 * honored consistently across clients. Keep the values here so the renderer
 * and tests share one source of truth.
 */
export type HeaderTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';

/** Border colors used on collapsible tool panels (a subset of the palette). */
export type ToolBorderColor =
  | 'orange'
  | 'blue'
  | 'turquoise'
  | 'wathet'
  | 'purple'
  | 'violet'
  | 'grey'
  | 'red';

export interface CardHeader {
  template: HeaderTemplate;
  title: string;
}

/**
 * Braille dot frames used as the running-card "spinner". Feishu cards have no
 * CSS/animation support (standard_icon is a static SVG that never rotates), so
 * the only way to show activity is to swap the leading glyph on each refresh.
 */
export const CARD_SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

/** Pick the spinner frame for a wall-clock instant. Pure; tests pass `now`. */
export function spinnerFrame(now: number, frameMs = 500): string {
  return CARD_SPINNER_FRAMES[Math.floor(now / frameMs) % CARD_SPINNER_FRAMES.length]!;
}

/**
 * Pick the header color + title for the card's current phase. Terminal states
 * win over the running footer status. Running states lead with the animated
 * braille frame; terminal states use their static status glyph.
 */
export function cardHeader(state: RunState, agentName = 'Agent', now = Date.now()): CardHeader {
  switch (state.terminal) {
    case 'done':
      return { template: 'green', title: `✅ ${agentName} 已完成` };
    case 'error':
      return { template: 'red', title: `⚠️ ${agentName} 执行失败` };
    case 'interrupted':
      return { template: 'grey', title: `⏹ ${agentName} 已中断` };
    case 'idle_timeout':
      return {
        template: 'orange',
        title: `⏱ ${agentName} 已超时（${state.idleTimeoutMinutes ?? 0} 分钟无响应）`,
      };
    default: {
      const lead = spinnerFrame(now);
      if (state.footer === 'tool_running') {
        return { template: 'wathet', title: `${lead} ${agentName} 正在调用工具` };
      }
      if (state.footer === 'streaming') {
        return { template: 'indigo', title: `${lead} ${agentName} 正在回复` };
      }
      return { template: 'blue', title: `${lead} ${agentName} 正在思考` };
    }
  }
}

const TOOL_COLOR_RULES: ReadonlyArray<{ readonly match: RegExp; readonly color: ToolBorderColor }> = [
  { match: /^(bash|shell)$/i, color: 'orange' },
  { match: /^(read|write|edit|multiedit|notebookedit)$/i, color: 'blue' },
  { match: /^(grep|glob|ast_grep_search|search)$/i, color: 'turquoise' },
  { match: /^(webfetch|websearch)$/i, color: 'wathet' },
  { match: /^(task|agent)$/i, color: 'purple' },
  { match: /^skill$/i, color: 'violet' },
];

/** Border color for a tool panel; failures always render red. */
export function toolBorderColor(tool: ToolEntry): ToolBorderColor {
  if (tool.status === 'error') return 'red';
  for (const rule of TOOL_COLOR_RULES) {
    if (rule.match.test(tool.name)) return rule.color;
  }
  return 'grey';
}
