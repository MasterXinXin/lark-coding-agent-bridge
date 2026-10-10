# 飞书卡片交互反馈补全设计（敲键盘 reaction + 运行中转圈动效）

- 日期：2026-10-10
- 状态：已与用户确认设计方向
- 范围：`messageReply: 'card'` 模式的**交互反馈**（`markdown` / `text` 模式不动）

## 1. 背景与问题

卡片美化（见 `2026-10-10-feishu-card-beautify-design.md`）落地后，卡片模式仍缺两处交互反馈：

1. **缺少「敲键盘」reaction**。参考项目普遍在用户提问消息上加一个 `Typing`（敲键盘）表情作为「已收到、正在处理」的即时反馈。当前实现**主动跳过**了它：
   ```ts
   // src/bot/channel.ts（现状）
   const reactionPromise =
     cotEnabled || replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);
   ```
   `src/bot/reaction.ts` 的注释理由是「卡片本身已显示正在思考」，但用户期望与参考项目一致，保留该反馈。

2. **卡片无「执行中」动效**。运行态 header 只有静态文案+颜色，用户无法一眼看出「还在跑」。用户希望有类似「转圈」的进行中动效。

### 关键技术约束

- 飞书 **`standard_icon`（含 `loading_outlined`）是静态 SVG，客户端不提供任何动画**；固定角度的转圈反而暗示「卡住」。
- 业界可行做法（参考 `roc-zjp/homing` 设计系统文档）：**用盲文点阵字符帧 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 作标题前缀，随刷新推帧**，终态回到静态图标。
- SDK 侧：`@larksuite/channel` 的卡片 `ctrl.update(next)` 只是**设置目标卡片状态**（非阻塞），真正的 patch 由内置 `Throttle`（`streamThrottleMs: 400`）+ `UpdateQueue` **串行节流**。因此心跳重渲染天然安全，无需自建队列；实际请求约 2 次/秒，远低于飞书单卡 10 QPS 上限。

## 2. 目标与非目标

### 目标
- 卡片模式下，用户提问消息在其 run 期间显示 `Typing`（敲键盘）reaction，结束时移除。
- 卡片运行中，header 标题前导图标按盲文帧循环（约 500ms 一帧），终态为静态状态图标。
- 保持 `renderCard` 纯函数特性（帧由 `now` 推导，测试可注入固定时间）。
- 不引入新依赖、配置开关或流式协议改动。

### 非目标
- 不改 `markdown` / `text` 模式的渲染与反馈。
- 不实现真正的 CSS/网络动画（飞书不支持）。
- 不改终止按钮、邮件脱敏、体积策略、wake-up banner 文案。
- 不为动效新增用户配置项。

## 3. 设计

### 3.1 恢复「敲键盘」reaction（`src/bot/channel.ts` / `src/bot/reaction.ts`）

把卡片模式从跳过条件中移除，仅 CoT 模式继续跳过（CoT 有独立气泡作为反馈）：

```ts
const reactionPromise = cotEnabled ? undefined : addWorkingReaction(channel, lastMsg.messageId);
```

- 触达消息：`lastMsg.messageId`（主 run 路径）。wake-up 路径无用户消息，不添加。
- 生命周期：沿用既有 `scheduleWorkingReactionCleanup`（`finally` 中调用）在 run 结束后移除；添加/移除失败均只记日志、不影响回复流程。
- 同步更新 `reaction.ts` 顶部注释，移除「card 模式不需要」的过时表述。
- 事件流中已有的 `reaction added/removed` 结构化日志不变。

### 3.2 运行中「转圈」动效（盲文帧 + 心跳）

#### 3.2.1 帧与 header（`src/card/theme.ts`）

```ts
export const CARD_SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;

/** 按墙钟时间取当前帧；纯函数，测试注入固定 now。frameMs 默认 500。 */
export function spinnerFrame(now: number, frameMs = 500): string {
  return CARD_SPINNER_FRAMES[Math.floor(now / frameMs) % CARD_SPINNER_FRAMES.length]!;
}

export function cardHeader(state: RunState, agentName = 'Agent', now = Date.now()): CardHeader;
```

- 运行态（`terminal === 'running'` 的三种 footer）标题：**用当前帧替换 `🤖`**，例如 `⠋ deepseek-flash 正在思考`。
- 终态标题不变：`✅ {agent} 已完成` / `⚠️ {agent} 执行失败` / `⏹ {agent} 已中断` / `⏱ {agent} 已超时（N 分钟无响应）`。
- 仅一个前导图标，避免 `⠋ 🤖` 双图标并列。

#### 3.2.2 渲染层（`src/card/run-renderer.ts`）

- 在 `renderCard` 顶部计算一次 `const now = options.now ?? Date.now();`，同时用于 `cardHeader(state, options.agentName, now)` 与耗时 chip（`elapsedText` 改为接收 `now`，保证一帧内时钟一致）。
- 其余结构、元素顺序、脱敏、summary、stop 按钮不变。

#### 3.2.3 心跳（`src/card/heartbeat.ts` + `src/bot/channel.ts`）

新增小工具（便于脱离 SDK 单测）：

```ts
// src/card/heartbeat.ts
export const CARD_HEARTBEAT_MS = 500;

/** 启动周期性 tick，返回停止函数。纯定时器包装，便于用假定时器单测。 */
export function startCardHeartbeat(tick: () => void, intervalMs = CARD_HEARTBEAT_MS): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

在卡片 producer（主 run 卡片分支与 wake-up 卡片分支）拿到 `cardCtrl` 后启动：

```ts
cardCtrl = ctrl;
await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
stopHeartbeat = startCardHeartbeat(() => {
  if (cardCtrl) void cardCtrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
});
await renderDone;
stopHeartbeat?.();
```

- 心跳读取 `latestState`（由 `processAgentStream` 的 flush 持续更新），因此帧随墙钟推进、内容始终是最新状态。
- `renderDone`（= `processAgentStream` 完成）后立即停止；终态若有极少数迟到心跳，也只是幂等重渲染终态卡（无 spinner）。
- `/doctor` 为一次性静态卡片，不启动心跳。
- 节流/并发：依赖 SDK 的 `Throttle`+`UpdateQueue`；心跳约 2 次/秒。

## 4. 错误处理与边界

- **reaction 失败**：`addWorkingReaction`/`removeReaction` 已吞异常并记日志，不阻塞回复。
- **心跳与事件更新并发**：`ctrl.update` 为「设置目标态 + 合并节流」，无竞态；patch 由 SDK 串行队列执行。
- **帧与 `renderCard` 纯度**：帧由 `options.now` 推导；不传时用 `Date.now()`，快照测试显式传固定 `now`。
- **邮件脱敏**：帧为排版字符，`deepMaskEmails` 不受影响。
- **体积**：仅标题多 1 个字符，`collapsedToolSummary` 体积策略不变。

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/bot/channel.ts` | reaction 条件；主/wake-up 卡片分支接入心跳 |
| `src/bot/reaction.ts` | 注释更新 |
| `src/card/theme.ts` | `CARD_SPINNER_FRAMES`、`spinnerFrame`、`cardHeader(…, now)` |
| `src/card/run-renderer.ts` | 统一 `now`，传入 `cardHeader`/耗时 |
| `src/card/heartbeat.ts` | 新增 `startCardHeartbeat`、`CARD_HEARTBEAT_MS` |

## 6. 测试

- `tests/unit/card/theme.test.ts`：`spinnerFrame` 帧映射与回绕；运行态 header 含帧、终态不含。
- `tests/unit/card/heartbeat.test.ts`：`vi.useFakeTimers` 验证按间隔 tick、停止后不再 tick、`unref` 不阻塞进程。
- `tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap`：运行态快照更新（固定 `now`）。
- reaction：在现有 bot 集成测试中新增断言——卡片模式触发消息被 `addReaction('Typing')`，run 结束被移除。
- 回归：wake-up 集成测试、邮件脱敏、`renderText` 快照保持不变。

## 7. 验收标准

1. 卡片模式下，用户提问消息在 run 期间显示「敲键盘」reaction，结束后消失。
2. 卡片运行中 header 前导字符按盲文帧约每 500ms 转一帧；完成/出错/中断/超时为对应静态图标，无帧。
3. `renderCard` 仍为纯函数；不传 `now` 时用当前时间。
4. 现有快照与集成测试（wake-up banner、邮件脱敏、stop 按钮签名）不回归。
5. 额外卡片请求约为 2 次/秒，终端态后停止。
