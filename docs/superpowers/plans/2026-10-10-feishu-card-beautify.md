# 飞书流式卡片美化（方案 B）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `messageReply: 'card'` 的流式卡片增加状态化彩色 header、按工具类型着色的面板与两行页脚元信息，同时保持流式、summary、终止按钮、邮件脱敏与体积上限行为不变。

**Architecture:** 新增纯函数主题模块 `src/card/theme.ts`（状态→header 色/标题、工具名→边框色）；`run-renderer.ts` 消费它并新增页脚；`run-state.ts` 追加 `system`/`usage` 事件记录；`.ts` 调用方（`channel.ts`、`commands/index.ts`）注入 `agentName` / `startedAt`。渲染保持纯函数，耗时通过 `options.now` 注入以保证快照可测。

**Tech Stack:** TypeScript (ESM, `.js` 后缀导入)、Vitest 2、飞书 CardKit 2.0 卡片 JSON、pnpm。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/card/theme.ts` | header 主题（状态→色/标题）与工具边框色映射 | 新建 |
| `src/card/run-state.ts` | 事件归约；新增 `model`/`usage` 记录 | 修改 |
| `src/card/run-renderer.ts` | 卡片渲染；新增 header、页脚、彩色边框 | 修改 |
| `src/bot/channel.ts` | 注入 `agentName`/`startedAt` | 修改 |
| `src/commands/index.ts` | `/doctor` 卡片注入 `agentName`/`startedAt` | 修改 |
| `tests/unit/card/theme.test.ts` | 主题映射单测 | 新建 |
| `tests/unit/card/run-state-usage.test.ts` | model/usage 归约单测 | 新建 |
| `tests/unit/card/run-renderer-beautify.test.ts` | header/页脚/边框断言 | 新建 |
| `tests/unit/card/run-renderer.snapshot.test.ts.snap` | 更新快照 | 修改（由 `-u` 生成） |
| `tests/integration/bot/wake-up-rendering.test.ts` | 补 header 断言 | 修改 |

---

## Task 1: 主题映射模块 `src/card/theme.ts`

**Files:**
- Create: `src/card/theme.ts`
- Test: `tests/unit/card/theme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/card/theme.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/card/theme.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/card/theme.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/card/theme.ts`:

```ts
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
 * Pick the header color + title for the card's current phase. Terminal states
 * win over the running footer status.
 */
export function cardHeader(state: RunState, agentName = 'Agent'): CardHeader {
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
    default:
      if (state.footer === 'tool_running') {
        return { template: 'wathet', title: `🤖 ${agentName} 正在调用工具` };
      }
      if (state.footer === 'streaming') {
        return { template: 'indigo', title: `🤖 ${agentName} 正在回复` };
      }
      return { template: 'blue', title: `🤖 ${agentName} 正在思考` };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/card/theme.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/card/theme.ts tests/unit/card/theme.test.ts
git commit -m "feat(card): add theme mapping for header and tool colors"
```

---

## Task 2: `run-state.ts` 记录 model 与 usage

**Files:**
- Modify: `src/card/run-state.ts`
- Test: `tests/unit/card/run-state-usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/card/run-state-usage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/card/run-state-usage.test.ts`
Expected: FAIL — `state.model` is `undefined` / `state.usage` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/card/run-state.ts`:

(a) Add the `RunUsage` interface and two fields to `RunState`. After the `ToolEntry` block and before `Block`, add:

```ts
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}
```

(b) Inside `interface RunState`, after `idleTimeoutMinutes?: number;`, add:

```ts
  /** Model reported by the agent's `system` event, if any. */
  model?: string;
  /** Aggregated token/cost usage for the run, if the agent reported it. */
  usage?: RunUsage;
```

(c) In `reduce`, add two cases immediately before `default:`:

```ts
    case 'system': {
      return evt.model ? { ...state, model: evt.model } : state;
    }

    case 'usage': {
      return { ...state, usage: mergeUsage(state.usage, evt) };
    }
```

(d) At the bottom of the file (after `finalizeIfRunning`), add:

```ts
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningOutputTokens',
  'costUsd',
] as const;

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

/**
 * Sum usage across events. Some agents emit usage incrementally, so a plain
 * overwrite would lose earlier counts. `undefined` inputs are skipped so a
 * field only appears in the result once the agent has reported it.
 */
function mergeUsage(prev: RunUsage | undefined, evt: UsageEvent): RunUsage {
  const merged: RunUsage = { ...prev };
  for (const key of USAGE_KEYS) {
    const increment = evt[key];
    if (increment === undefined) continue;
    merged[key] = (merged[key] ?? 0) + increment;
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/card/run-state-usage.test.ts tests/unit/card/run-state-schema.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add src/card/run-state.ts tests/unit/card/run-state-usage.test.ts
git commit -m "feat(card): record model and usage in run state"
```

---

## Task 3: 渲染器 header / 页脚 / 彩色边框

**Files:**
- Modify: `src/card/run-renderer.ts`
- Test: `tests/unit/card/run-renderer-beautify.test.ts`
- Update: `tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/card/run-renderer-beautify.test.ts`:

```ts
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
    const card = renderCard(state, { agentName: 'Coder', startedAt: 1_000, now: 13_200 }) as CardShape;
    const dump = JSON.stringify(card.body?.elements ?? []);
    expect(dump).toContain('⏱ 12.2s');
    expect(dump).toContain('🔧 1 次工具');
    expect(dump).toContain('🧩 openai/gpt-5');
  });

  it('renders a usage footer only when usage is present', () => {
    const withUsage = stateFrom([
      { type: 'usage', inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, costUsd: 0.0123 },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const dump = JSON.stringify(renderCard(withUsage).body?.elements ?? []);
    expect(dump).toContain('↑ 120 ↓ 30');
    expect(dump).toContain('缓存 40');
    expect(dump).toContain('$0.0123');

    const noUsage = JSON.stringify(renderCard(initialState).body?.elements ?? []);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/card/run-renderer-beautify.test.ts`
Expected: FAIL — `card.header` is `undefined`; footer chips missing; bash panel border is `grey`.

- [ ] **Step 3: Implement the renderer changes**

In `src/card/run-renderer.ts`:

(a) Update the imports at the top to:

```ts
import { deepMaskEmails } from './mask-email.js';
import type { Block, FooterStatus, RunState, ToolEntry } from './run-state.js';
import { cardHeader, toolBorderColor, type ToolBorderColor } from './theme.js';
import { toolBodyMd, toolHeaderText } from './tool-render.js';
```

(b) Extend `RunCardRenderOptions` to:

```ts
export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /**
   * Optional banner shown at the top of the card. Used by the wake-up
   * watcher to signal "this card is the bot continuing on its own after a
   * background task finished, not a reply to a user message you just sent".
   */
  headerBanner?: string;
  /** Display name for the card header title (e.g. "opencode"). */
  agentName?: string;
  /** Epoch ms when the run started — enables the elapsed-time footer chip. */
  startedAt?: number;
  /** Override "now" for deterministic renders (tests). Defaults to Date.now(). */
  now?: number;
}
```

(c) Replace the body of `renderCard` with:

```ts
export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];
  const header = cardHeader(state, options.agentName);

  if (options.headerBanner) {
    elements.push(noteMd(options.headerBanner));
  }

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  elements.push(footerMd(state, options));

  if (state.terminal === 'running') {
    elements.push(stopButton(options));
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  return deepMaskEmails({
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: header.title },
      template: header.template,
    },
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
}
```

(d) Replace `toolPanel` with:

```ts
function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: toolBorderColor(tool),
    body: toolBodyMd(tool) || '_无输出_',
  });
}
```

(e) Change `PanelOpts.border` to accept tool colors:

```ts
interface PanelOpts {
  title: string;
  expanded: boolean;
  border: ToolBorderColor | 'blue';
  body: string;
}
```

(f) Delete the now-unused `footerStatus` function, and add these functions near `summaryText`:

```ts
function footerMd(state: RunState, options: RunCardRenderOptions): object {
  const chips: string[] = [`\`${summaryText(state)}\``];

  const elapsed = elapsedText(options);
  if (elapsed) chips.push(`⏱ ${elapsed}`);

  const toolCount = state.blocks.filter((b) => b.kind === 'tool').length;
  if (toolCount > 0) chips.push(`🔧 ${toolCount} 次工具`);

  if (state.model) chips.push(`🧩 ${truncate(state.model, 48)}`);

  const lines = [chips.join(' · ')];
  const usage = usageText(state);
  if (usage) lines.push(usage);

  return noteMd(lines.join('\n'));
}

function elapsedText(options: RunCardRenderOptions): string | null {
  if (!options.startedAt) return null;
  const now = options.now ?? Date.now();
  return formatDuration(Math.max(0, now - options.startedAt));
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function usageText(state: RunState): string | null {
  const usage = state.usage;
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`↑ ${usage.inputTokens ?? 0} ↓ ${usage.outputTokens ?? 0}`);
  }
  if (usage.cachedInputTokens !== undefined) parts.push(`缓存 ${usage.cachedInputTokens}`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (parts.length === 0) return null;
  return parts.map((part) => `\`${part}\``).join(' · ');
}
```

`FooterStatus` remains used by `summaryText`'s type, so the import stays.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm exec vitest run tests/unit/card/run-renderer-beautify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update and review snapshots**

Run: `pnpm exec vitest run tests/unit/card/run-renderer.snapshot.test.ts -u`
Expected: PASS with snapshots rewritten.

Then open `tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap` and confirm every snapshot now has a `header` block with the expected `template` (`blue` while running, `green` for done, `red` for error, `grey` for interrupted, `orange` for idle-timeout) and a footer `markdown` element. Confirm no snapshot lost the `⏹ 终止` button or the wake-up text.

- [ ] **Step 6: Run the whole card unit suite**

Run: `pnpm exec vitest run tests/unit/card`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/card/run-renderer.ts tests/unit/card/run-renderer-beautify.test.ts tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap
git commit -m "feat(card): stateful header, tool colors, and metadata footer"
```

---

## Task 4: 调用方注入 `agentName` / `startedAt`

**Files:**
- Modify: `src/bot/channel.ts`
- Modify: `src/commands/index.ts`

- [ ] **Step 1: Inject options in the main run path**

In `src/bot/channel.ts`, replace the `cardRenderOptions` construction at line 1158 with:

```ts
  const cardRenderOptions = {
    agentName: agent.displayName,
    startedAt: Date.now(),
    ...(callbackAuth
      ? {
          signCallback: (action: string) =>
            callbackAuth.sign({
              runId: execution.runId,
              scope,
              chatId,
              operatorOpenId: firstMsg.senderId,
              action,
              policyFingerprint: flow.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };
```

- [ ] **Step 2: Inject options in the wake-up path**

In `src/bot/channel.ts`, inside the wake-up watcher, change the `cardRenderOptions` construction at line 1605 to add two fields right after `headerBanner`:

```ts
      const cardRenderOptions: RunCardRenderOptions = {
        headerBanner: '🔔 _后台任务完成后由 agent 主动接续_',
        agentName: opts.agent.displayName,
        startedAt: Date.now(),
        ...(opts.callbackAuth
          ? {
              signCallback: (action: string) =>
                opts.callbackAuth!.sign({
                  runId: turn.runId,
                  scope: opts.scope,
                  chatId: opts.chatId,
                  operatorOpenId: opts.operatorOpenId,
                  action,
                  policyFingerprint: opts.policyFingerprint,
                  ttlMs: 24 * 60 * 60 * 1000,
                }),
            }
          : {}),
      };
```

- [ ] **Step 3: Inject options in the `/doctor` path**

In `src/commands/index.ts`, immediately before the `try {` at line 1333, add:

```ts
  const doctorCardOptions = { agentName: ctx.agent.displayName, startedAt: Date.now() };
```

Then pass it as the second argument to the three `renderCard(...)` calls in that block:
- line 1340: `initial: renderCard(withDoctorReport(initialState, doctorReport('pending')), doctorCardOptions),`
- line 1346: `ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus())), doctorCardOptions));`
- line 1392: `card: renderCard(withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))), doctorCardOptions),`

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Run unit + integration tests**

Run: `pnpm exec vitest run tests/unit/card tests/integration/bot/wake-up-rendering.test.ts`
Expected: PASS. The wake-up test still finds the banner text `后台任务完成后由 agent 主动接续` and the streamed `background task result`.

- [ ] **Step 6: Commit**

```bash
git add src/bot/channel.ts src/commands/index.ts
git commit -m "feat(card): inject agent name and start time into run cards"
```

---

## Task 5: 补集成断言与全量验证

**Files:**
- Modify: `tests/integration/bot/wake-up-rendering.test.ts`

- [ ] **Step 1: Assert the wake-up card carries the new header**

In `tests/integration/bot/wake-up-rendering.test.ts`, inside the first test after the existing `expect(dump).toContain('后台任务完成后由 agent 主动接续');` (around line 382), add:

```ts
    // The beautified card always carries a stateful header.
    expect(dump).toContain('"header"');
    expect(dump).toContain('"template"');
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm exec vitest run tests/integration/bot/wake-up-rendering.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Run the full unit suite**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 4: Run the full integration suite**

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/bot/wake-up-rendering.test.ts
git commit -m "test(card): assert wake-up card carries a header"
```

---

## 验收对照（映射 spec §10）

| 验收项 | 覆盖任务 |
|---|---|
| 运行态彩色 header，随思考→工具→输出切换 | Task 1, 3 |
| 工具面板按类型着色，失败红 | Task 1, 3 |
| 页脚状态/耗时/工具次数；有模型/usage 时追加 | Task 2, 3 |
| 完成绿 / 出错红 / 中断灰 / 超时橙 | Task 1, 3 |
| ⏹ 终止按钮与签名行为不变 | Task 3（快照保留按钮）、Task 4（签名选项透传） |
| wake-up 集成测试与邮件脱敏不回归 | Task 3（deepMaskEmails 仍在末尾）、Task 4, 5 |
