# 飞书卡片交互反馈补全 — 实现计划

- 日期：2026-10-10
- Spec：`docs/superpowers/specs/2026-10-10-feishu-card-animation-design.md`
- 范围：`messageReply: 'card'` 模式（恢复「敲键盘」reaction + 运行中盲文帧「转圈」动效）

> **执行方式**：在仓库根目录 `D:\code\lark-coding-agent-bridge` **原地**（`main` 分支）实现，
> **不建 worktree**（避免重新安装 `node_modules`）。每完成一个 Task 提交一次。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/card/theme.ts` | 帧常量、`spinnerFrame`、`cardHeader` 注入帧 | 修改 |
| `src/card/run-renderer.ts` | 统一时钟并把 `now` 传给 `cardHeader`/耗时 | 修改 |
| `src/card/heartbeat.ts` | `startCardHeartbeat`、`CARD_HEARTBEAT_MS` | 新增 |
| `src/bot/channel.ts` | reaction 条件；两个卡片 producer 接入心跳 | 修改 |
| `src/bot/reaction.ts` | 更新过时注释 | 修改 |
| `tests/unit/card/theme.test.ts` | 帧映射 + 运行/终态 header | 修改 |
| `tests/unit/card/heartbeat.test.ts` | 心跳定时器行为 | 新增 |
| `tests/unit/card/run-renderer.snapshot.test.ts` | 固定 `now` | 修改 |
| `tests/unit/card/run-renderer-beautify.test.ts` | 固定 `now` + 期望盲文帧 | 修改 |
| `tests/unit/card/__snapshots__/*.snap` | 快照更新 | 重生成 |
| `tests/integration/bot/markdown-stream-startup-failure.test.ts` | 卡片模式 reaction + spinner 断言 | 修改 |

---

## Task 1：`theme.ts` 盲文帧 + header

**文件**：`src/card/theme.ts`、`tests/unit/card/theme.test.ts`

### 1.1 先写失败测试

把 `tests/unit/card/theme.test.ts` 顶部 import 与 describe 改为（新增 `spinnerFrame`、`CARD_SPINNER_FRAMES`）：

```ts
import { describe, expect, it } from 'vitest';
import {
  CARD_SPINNER_FRAMES,
  cardHeader,
  spinnerFrame,
  toolBorderColor,
} from '../../../src/card/theme.js';
import { initialState, type RunState, type ToolEntry } from '../../../src/card/run-state.js';

const FIXED_NOW = 0; // frame index 0 -> '⠋'
```

在 `describe('card theme', ...)` 内，把 `maps running footer states ...` 一例改为：

```ts
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
```

`maps tool names to border colors ...` 一例保持不变。

### 1.2 运行测试确认失败

```
pnpm vitest run tests/unit/card/theme.test.ts
```

预期：`spinnerFrame` 未导出 / header 标题不匹配，失败。

### 1.3 实现

在 `src/card/theme.ts` 增加：

```ts
/** Braille dot frames used as the running-card "spinner". Feishu cards have no
 * CSS/animation support (standard_icon is a static SVG), so the only way to
 * show activity is to swap the glyph on each card refresh. */
export const CARD_SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
] as const;

/** Pick the spinner frame for a wall-clock instant. Pure; tests pass `now`. */
export function spinnerFrame(now: number, frameMs = 500): string {
  return CARD_SPINNER_FRAMES[Math.floor(now / frameMs) % CARD_SPINNER_FRAMES.length]!;
}
```

修改 `cardHeader`：新增 `now` 参数，运行态用帧替换 `🤖`（终态分支不变）：

```ts
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
```

> 保留文件顶部原有 `default` 里的 `🤖` 文案以外的一切；只把三处前缀换成 `${lead}`。

### 1.4 运行测试通过

```
pnpm vitest run tests/unit/card/theme.test.ts
```

### 1.5 提交

```
git add src/card/theme.ts tests/unit/card/theme.test.ts
git commit -m "feat(card): braille spinner frames in running card header"
```

---

## Task 2：`run-renderer.ts` 统一时钟

**文件**：`src/card/run-renderer.ts`、`tests/unit/card/run-renderer.snapshot.test.ts`、`tests/unit/card/run-renderer-beautify.test.ts`

### 2.1 实现

`renderCard` 顶部一次性算好 `now`，传给 `cardHeader` 与 `footerMd`：

```ts
export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const now = options.now ?? Date.now();
  const elements: object[] = [];
  const header = cardHeader(state, options.agentName, now);
  // ...
  elements.push(footerMd(state, options, now));
  // ...
}
```

`footerMd` 与 `elapsedText` 接收 `now`：

```ts
function footerMd(state: RunState, options: RunCardRenderOptions, now: number): object {
  // ...
  const elapsed = elapsedText(options, now);
  // ...
}

function elapsedText(options: RunCardRenderOptions, now: number): string | null {
  if (options.startedAt === undefined) return null;
  const delta = now - options.startedAt;
  if (!Number.isFinite(delta)) return null;
  return formatDuration(Math.max(0, delta));
}
```

### 2.2 更新快照测试为固定时钟

`tests/unit/card/run-renderer.snapshot.test.ts`：把 `expectCard` 改为传入固定 `now`：

```ts
const FIXED_NOW = 0; // -> header 前缀 '⠋'
// ...
function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state, { now: FIXED_NOW })));
}
```

`tests/unit/card/run-renderer-beautify.test.ts`：`adds a stateful header` 一例改为：

```ts
    const card = renderCard(initialState, { agentName: 'Coder', now: 0 }) as CardShape;
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '⠋ Coder 正在思考' },
      template: 'blue',
    });
```

（`done` 断言不变。）

### 2.3 重生成快照

```
pnpm vitest run tests/unit/card/run-renderer.snapshot.test.ts -u
pnpm vitest run tests/unit/card/run-renderer-beautify.test.ts
```

检查 diff：仅运行态 header 的 `🤖 Agent ...` → `⠋ Agent ...`（终态快照不变）。

### 2.4 提交

```
git add src/card/run-renderer.ts tests/unit/card/run-renderer.snapshot.test.ts tests/unit/card/__snapshots__ tests/unit/card/run-renderer-beautify.test.ts
git commit -m "feat(card): single clock drives header spinner and elapsed chip"
```

---

## Task 3：`heartbeat.ts` 心跳工具

**文件**：`src/card/heartbeat.ts`（新增）、`tests/unit/card/heartbeat.test.ts`（新增）

### 3.1 先写失败测试

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_HEARTBEAT_MS, startCardHeartbeat } from '../../../src/card/heartbeat.js';

describe('card heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the configured interval', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick, 500);

    vi.advanceTimersByTime(499);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stops ticking after the stop function runs', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick, 500);

    vi.advanceTimersByTime(500);
    stop();
    vi.advanceTimersByTime(5_000);

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('defaults to CARD_HEARTBEAT_MS', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick);

    vi.advanceTimersByTime(CARD_HEARTBEAT_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);

    stop();
  });
});
```

### 3.2 运行确认失败

```
pnpm vitest run tests/unit/card/heartbeat.test.ts
```

### 3.3 实现

```ts
// src/card/heartbeat.ts

/**
 * Cadence of the running-card spinner heartbeat. Kept in lockstep with the
 * default frame interval in `theme.spinnerFrame` (500ms → one braille frame
 * per tick, a full rotation every 5s).
 */
export const CARD_HEARTBEAT_MS = 500;

/**
 * Invoke `tick` every `intervalMs`, returning a stop function.
 *
 * The Feishu card controller's `update()` is a non-blocking "set desired
 * state" call; the SDK's own Throttle + UpdateQueue coalesce and serialize the
 * actual patches (~2/s here, well under the 10 QPS/card limit). The timer is
 * `unref`'d so a heartbeat never keeps the process alive on its own.
 *
 * Extracted from `channel.ts` so it is unit-testable with fake timers,
 * independent of the SDK.
 */
export function startCardHeartbeat(tick: () => void, intervalMs = CARD_HEARTBEAT_MS): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

### 3.4 运行测试通过并提交

```
pnpm vitest run tests/unit/card/heartbeat.test.ts
git add src/card/heartbeat.ts tests/unit/card/heartbeat.test.ts
git commit -m "feat(card): add unref'd spinner heartbeat helper"
```

---

## Task 4：恢复「敲键盘」reaction（卡片模式）

**文件**：`src/bot/channel.ts`、`src/bot/reaction.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`

### 4.1 先写失败集成测试

在 `tests/integration/bot/markdown-stream-startup-failure.test.ts` 现有 `describe('markdown stream startup failures', ...)`（结束于 `});`，约 430 行）之后、`createHarness` 声明之前，新增：

```ts
describe('card reply mode feedback', () => {
  it('adds a typing reaction and renders a running spinner, then cleans up', async () => {
    const cards: Array<{ header?: { title?: { content?: string } } }> = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            cards.push(next as { header?: { title?: { content?: string } } });
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_ack', 'run'));

    // 卡片模式下也应在触发消息上打「敲键盘」reaction。
    await waitFor(() =>
      h.channel.rawClient.im.v1.messageReaction.create.mock.calls.length > 0,
    );
    expect(h.channel.rawClient.im.v1.messageReaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_card_ack' },
        data: { reaction_type: { emoji_type: 'Typing' } },
      }),
    );

    // 运行态 header 前导字符是盲文帧。
    await waitFor(() =>
      cards.some((card) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(card.header?.title?.content ?? '')),
    );

    // run 结束后移除 reaction。
    await waitFor(() =>
      h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
    );
  });
});
```

### 4.2 运行确认失败

```
pnpm vitest run tests/integration/bot/markdown-stream-startup-failure.test.ts -t "typing reaction"
```

预期：`create` 未被调用（当前卡片模式跳过 reaction），失败。

### 4.3 实现

`src/bot/channel.ts`（约 1177-1182）——把卡片模式从跳过条件里去掉，并更新注释：

```ts
  // Signal "got it, working on it" on the user's message. CoT mode has its own
  // bubble, so it is the only mode that skips the reaction; card mode keeps it
  // alongside the streaming card. Never let the outbound call block event
  // draining.
  const reactionPromise = cotEnabled ? undefined : addWorkingReaction(channel, lastMsg.messageId);
```

`src/bot/reaction.ts` 顶部注释改为：

```ts
/**
 * Add a "Typing" reaction (敲键盘) to a message to give the user an instant
 * "I got your message and I'm responding" cue while the agent is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Used by every non-CoT reply mode (card / markdown / text); CoT
 * has its own bubble instead.
 *
 * Returns the reaction id on success, undefined on any failure. ...
 */
```

> `renderWakeUpTurnAsCard` 无用户消息，**不加** reaction；其注释「no working reaction」保持不变。

### 4.4 运行测试通过并提交

```
pnpm vitest run tests/integration/bot/markdown-stream-startup-failure.test.ts
git add src/bot/channel.ts src/bot/reaction.ts tests/integration/bot/markdown-stream-startup-failure.test.ts
git commit -m "feat(bot): keep typing reaction in card reply mode"
```

---

## Task 5：把心跳接入两个卡片 producer

**文件**：`src/bot/channel.ts`

### 5.1 导入

在 `src/bot/channel.ts` 的 card 相关 import 附近加入：

```ts
import { startCardHeartbeat } from '../card/heartbeat';
```

### 5.2 主 run 卡片分支（`replyMode === 'card'`，约 1270-1293）

```ts
    if (replyMode === 'card') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      let stopHeartbeat: (() => void) | undefined;
      let cardCtrl:
        | { update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        channel.stream(
          chatId,
          {
            card: {
              initial: renderCard(initialState, cardRenderOptions),
              producer: async (ctrl) => {
                producerStarted = true;
                if (progress.abandoned()) return;
                cardCtrl = ctrl;
                await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
                stopHeartbeat = startCardHeartbeat(() => {
                  if (cardCtrl) {
                    void cardCtrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
                  }
                });
                try {
                  await renderDone;
                } finally {
                  stopHeartbeat?.();
                  stopHeartbeat = undefined;
                }
              },
            },
          },
          sendOpts,
        ),
      );
```

> `onState` 的 flush 保持原样（`latestState = state; ... await cardCtrl.update(...)`），无需改动。

### 5.3 wake-up 卡片分支（`renderWakeUpTurnAsCard`，约 1731-1748）

同样处理：

```ts
  let latestState: RunState = initialState;
  let producerStarted = false;
  let stopHeartbeat: (() => void) | undefined;
  let cardCtrl:
    | { update(next: object | ((current: object) => object)): Promise<void> }
    | undefined;
  const progress = createLazyProgressStream(opts.scope, 'card', () =>
    opts.channel.stream(
      opts.chatId,
      {
        card: {
          initial: renderCard(initialState, opts.cardRenderOptions),
          producer: async (ctrl) => {
            producerStarted = true;
            if (progress.abandoned()) return;
            cardCtrl = ctrl;
            await ctrl.update(renderCard(opts.filterForPrefs(latestState), opts.cardRenderOptions));
            stopHeartbeat = startCardHeartbeat(() => {
              if (cardCtrl) {
                void cardCtrl.update(renderCard(opts.filterForPrefs(latestState), opts.cardRenderOptions));
              }
            });
            try {
              await renderDone;
            } finally {
              stopHeartbeat?.();
              stopHeartbeat = undefined;
            }
          },
        },
      },
      opts.sendOpts,
    ),
  );
```

### 5.4 类型检查 + 相关测试

```
pnpm typecheck
pnpm vitest run tests/integration/bot/markdown-stream-startup-failure.test.ts tests/integration/bot/wake-up-rendering.test.ts
```

### 5.5 提交

```
git add src/bot/channel.ts
git commit -m "feat(card): heartbeat-driven spinner while a card run is active"
```

---

## Task 6：全量验证

### 6.1 命令

```
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
```

预期：
- `typecheck` 无错误。
- `test:unit` 全绿（含 Task 1-3 新增/更新）。
- `test:integration` 全绿。**已知与本改动无关的既有失败**：`tests/integration/cli/start-codex-legacy-config.test.ts`（Windows 上 fake codex stub 调用 `sh`）——若它失败，确认 diff 不涉及该文件即可。
- `build` 成功。

### 6.2 手动验收（用户在真实飞书里）

1. 重建并重启桥接：`pnpm build` 后运行
   `node ./bin/lark-channel-bridge.mjs run --agent opencode --workspace D:\test --web-ui`。
2. 确保 `~/.lark-channel/config.json` 中 `preferences.messageReply` 为 `"card"`（配置在启动时读入内存，改文件后需重启）。
3. 在飞书发一条需要多步的消息，确认：
   - 提问消息上出现**敲键盘**表情，run 结束后消失；
   - 卡片 header 前导出现**盲文点阵旋转**（约每 0.5s 变一帧）；
   - 完成/出错/中断/超时后 header 变静态图标，旋转停止。
4. 查看日志 `~/.lark-channel/logs/bridge-*.jsonl`：`phase:"flush" event:"reply-mode"` 为 `card`；`react` 相关 `reaction added/removed` 正常。

### 6.3 清理快照的 CRLF 伪差异

Windows `core.autocrlf` 可能让 `.snap` 显示「已修改但无内容差异」。若 `git status` 出现：

```
git checkout -- tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap
```

### 6.4 最终提交（若 Task 6 有改动）

```
git add -A
git commit -m "test(card): refresh snapshots for spinner header"
```

---

## 验收清单

- [ ] 卡片模式下提问消息有「敲键盘」reaction，run 结束被移除。
- [ ] 运行态 header 前导为盲文帧并按 ~500ms 推进；终态为 `✅/⚠️/⏹/⏱` 且无帧。
- [ ] `renderCard` 仍为纯函数（不传 `now` 时用 `Date.now()`）。
- [ ] wake-up banner、邮件脱敏、终止按钮签名、体积策略无回归。
- [ ] `pnpm typecheck` / `test:unit` / `test:integration` / `build` 通过（排除已知 Windows 无关失败）。
