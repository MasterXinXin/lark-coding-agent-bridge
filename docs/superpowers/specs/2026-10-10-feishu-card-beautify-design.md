# 飞书流式卡片美化设计（方案 B · 参考项目风）

- 日期：2026-10-10
- 状态：已与用户确认方向（方案 B）
- 范围：`messageReply: 'card'` 流式卡片的渲染层美化 + 少量运行态数据补全

## 1. 背景与问题

当前 `renderCard`（`src/card/run-renderer.ts`）产出的流式卡片：

- 没有卡片 header，用户看不到"谁在处理、进行到哪一步"的视觉状态。
- 所有工具调用面板统一使用 `grey`/`red` 边框，无法一眼区分"检索 / 读写 / 命令 / 网络 / 子任务"。
- 运行状态只有一行 notation 文案（`🧠 正在思考` / `🧰 正在调用工具` / `✍️ 正在输出`），缺少耗时、模型、token 等参考项目普遍具备的元信息。
- 终态与运行态视觉差异仅靠面板折叠与按钮消失，成品的"结束感/成果感"弱。

参考的成熟开源实现（`Cheerwhy/hermes-lark-streaming`、`blackrion/hermes-lark-streaming`、`shareAI-lab/lark-channel`、`kaisleung96/feishu-streaming-card`）共同采用：

1. **状态化彩色 header**（思考=蓝 / 输出=靛蓝 / 完成=绿 / 出错=红 / 授权=橙）。
2. **按工具类型着色的面板**（Bash=橙、读写=蓝、检索=青、网络=浅蓝、子任务=紫）。
3. **页脚元信息**（状态 · 耗时 · 模型 / token · 缓存 · 费用）。
4. **终态换"成果卡"**（停止流式、折叠过程、绿色 header）。

## 2. 目标与非目标

### 目标
- 为卡片新增状态化 header（颜色 + 标题随运行阶段变化）。
- 为工具面板按类型着色，保留状态图标。
- 新增两行页脚元信息（状态/耗时/工具次数/模型；token/缓存/费用）。
- 终态呈现明确的完成/失败视觉。
- 保持流式、summary、终止按钮、邮件脱敏、体积上限等既有行为不变。

### 非目标
- 不改动 `@larksuite/channel` 的流式协议或数据流。
- 不新增网络请求、权限或运行时依赖。
- 不为视觉新增配置开关（直接替换现有卡片样式）。
- 不重写 `run-state` 的事件归约语义（仅追加 `system`/`usage` 的记录）。
- 不改动 `markdown` / `text` 两种 reply 模式的整体结构（仅同步工具图标，见 §7）。

## 3. 卡片结构

`renderCard(state, options)` 产出的 `body.elements` 自上而下：

1. **header**（新增，卡片级）
   - `header.template`：状态主题色（见 §4.1）
   - `header.title`：状态文案（见 §4.1）
2. **headerBanner**（保留）：wake-up 提示 markdown note，文案不变。
3. **推理折叠面板**（保留）：`🧠` 标题，`grey` 边框，运行中展开、结束后折叠。
4. **过程区**（按工具数量分支，见 §5）：
   - 工具 ≤2：每个工具一个独立彩色面板（最新运行中的展开，其余折叠）。
   - 工具 >2 运行中：折叠的"过程 · N 步"单面板 + 最新运行中工具独立面板。
   - 工具 >2 已结束：折叠的"过程 · N 步（已结束）"单面板，正文逐行列出各工具。
5. **正文 markdown**：agent 流式输出（按 block 顺序，保留现有分组逻辑）。
6. **终态提示**（保留）：中断 / 超时 / 出错 / 空内容。
7. **分隔线 + 页脚**（新增两行元信息，见 §6）。
8. **终止按钮**（保留，运行中显示，`signCallback` 逻辑不变）。

> 说明：不把推理与工具合并进单一"时间线"面板。当前 `run-state` 将推理存为整体字符串、工具存为有序 blocks，真正的时序交错需要改动归约语义，收益有限、回归面大。本方案保留"推理面板 + 过程区"两段式，仅做配色与元信息增强。

## 4. 视觉主题

### 4.1 header（新增 `src/card/theme.ts`）

| 运行阶段 | `footer` / `terminal` | template | 标题 |
|---|---|---|---|
| 思考 | `footer === 'thinking'` | `blue` | `🤖 {agent} 正在思考` |
| 调用工具 | `footer === 'tool_running'` | `wathet` | `🤖 {agent} 正在调用工具` |
| 输出 | `footer === 'streaming'` | `indigo` | `🤖 {agent} 正在回复` |
| 完成 | `terminal === 'done'` | `green` | `✅ {agent} 已完成` |
| 出错 | `terminal === 'error'` | `red` | `⚠️ {agent} 执行失败` |
| 中断 | `terminal === 'interrupted'` | `grey` | `⏹ {agent} 已中断` |
| 超时 | `terminal === 'idle_timeout'` | `orange` | `⏱ {agent} 已超时（{N} 分钟无响应）` |

- `{agent}` 取 `options.agentName`；缺省时用 `Agent`。
- header 标题使用 `plain_text`（避免 markdown 渲染差异），颜色由 `template` 控制。
- 飞书 header 仅支持命名色模板（`blue/wathet/turquoise/green/yellow/orange/red/carmine/violet/purple/indigo/grey`），不使用自定义 hex，保证跨端一致。

### 4.2 工具面板着色

新增映射（`theme.ts`），返回 `border.color`（命名色）：

| 工具（不区分大小写） | 颜色 | 状态图标 |
|---|---|---|
| `bash` / shell 类 | `orange` | ⏳ / ✅ / ❌ |
| `read` / `write` / `edit` / `notebookedit` | `blue` | 同上 |
| `grep` / `glob` / `ast_grep_search` | `turquoise` | 同上 |
| `webfetch` / `websearch` | `wathet` | 同上 |
| `task` / `agent` | `purple` | 同上 |
| `skill` | `violet` | 同上 |
| 其他 | `grey` | 同上 |

- **状态图标保留**（`⏳` 运行中 / `✅` 完成 / `❌` 失败），标题文案格式不变：`{icon} **{name}** — {summary}`。
- **边框颜色按类型**；`tool.status === 'error'` 时覆盖为 `red`（与现状一致，优先级最高）。
- 折叠的"过程"面板边框保持 `blue`；其正文逐行沿用 `toolHeaderText`（状态图标 + 名称 + 摘要），不做逐行着色（单个 markdown 元素无法分区着色）。

## 5. 过程区渲染规则

沿用 `groupBlocks` 的分组，细化为：

- `tools.length < COLLAPSE_TOOL_THRESHOLD (=3)`：每个工具 `toolPanel(tool, expanded = status==='running')`，边框按 §4.2。
- `finalized && tools.length >= 3`：单个 `collapsedToolSummary(tools, finalized=true)`。
- `running && tools.length >= 3`：`collapsedToolSummary(prior, false)` + 最新工具 `toolPanel(latest, true)`。

以上仅替换边框取色与（可选）标题前缀，结构不变。

## 6. 页脚元信息

页脚为 markdown notation 元素，chip 风格用行内代码模拟（飞书无独立 chip 元素）：

**第一行（总是显示）：**
`\`{状态}\` · \`⏱ {耗时}\` · \`🔧 {工具次数} 次工具\`` + 模型存在时 ` · \`🧩 {model}\``

**第二行（仅当存在 usage 数据）：**
`\`↑ {input} ↓ {output}\` · \`缓存 {cached}\`` + 费用存在时 ` · \`{cost}\``

字段来源与缺省：

- **状态**：沿用 `summaryText` 的文案（思考中 / 正在调用工具 / 正在输出 / 已完成 / 已中断 / 已超时 / 出错）。
- **耗时**：`options.startedAt` 存在时 `now - startedAt`，格式化为 `1.2s` / `45s` / `1m20s`；缺省省略。
- **工具次数**：`state.blocks` 中 `kind === 'tool'` 的数量（即使 `showToolCalls=false` 过滤了展示，也用过滤前状态统计，见 §7）。
- **模型**：`state.model`（来自 `system` 事件）或 `options.model`。
- **token/缓存/费用**：`state.usage`。

终端态页脚同样显示（耗时定格为结束时值），但不再显示终止按钮。

> 为保证快照可测，`renderCard` 保持纯函数：耗时通过 `options.startedAt` + `options.now`（或调用方计算后的 `options.elapsedMs`）传入，不在渲染层直接调用 `Date.now()`。**实现采用 `options.startedAt` + 可选 `options.now`，缺省 `now = Date.now()`**，测试显式传入固定 `now`。

## 7. 数据模型与调用方改动

### 7.1 `RunState`（`src/card/run-state.ts`）
新增只读可选字段：
```ts
model?: string;
usage?: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
};
```
`reduce` 追加两个 case：
- `case 'system'`：`model` 存在时写入 `state.model`。
- `case 'usage'`：与现有 `usage` 合并（各 token 字段累加，`costUsd` 累加），保证多次 usage 事件不丢失。

不改变其余事件语义。

### 7.2 `RunCardRenderOptions`（`src/card/run-renderer.ts`）
新增：
```ts
agentName?: string;
startedAt?: number;
now?: number;
```

### 7.3 调用方（`src/bot/channel.ts`）
- 构造 `cardRenderOptions` 时补充 `agentName: agent.displayName`、`startedAt: Date.now()`（每次 run 开始时取一次）。
- `commands/index.ts` 的 `/doctor` 卡片路径同样传入 `agentName`；`startedAt` 可选，不传则不显示耗时。
- `filterForPrefs` 保持"隐藏工具块"行为；页脚工具次数统计基于**过滤前**的 state。实现方式：`renderCard` 接收 `options.toolCount?: number`，由调用方用原始 state 计算并传入（避免 `renderCard` 收到的是已过滤状态）。若未传则回退为 `state.blocks` 统计。

### 7.4 `text-renderer.ts`
`renderText` 不变（markdown/text 模式无 header/页脚）。`toolHeaderText` 的状态图标逻辑不动，因此两种模式天然一致。

## 8. 边界与错误处理

- **邮件脱敏**：`deepMaskEmails` 仍在 `renderCard` 最后统一执行；新增的 header/页脚字段亦会被自动处理。
- **体积上限**：新增元素很小；`collapsedToolSummary` 仍丢弃工具正文，维持既有体积策略。页脚文本固定长度。
- **空内容**：`done` 且无任何元素时仍追加 `_（未返回内容）_`；此时页脚照常显示。
- **`agentName` 缺失**：回退 `Agent`。
- **`usage` 缺失**：不输出第二行。
- **header 与 streaming_mode 共存**：现有实现已在 `streaming_mode: true` 下输出折叠面板与按钮，新增 header 不改变该模式（本项目走整卡更新，而非受限的单元素 `stream_element` 增量协议）。
- **回退路径**：`sendManagedCard` 的 raw-card 回退、`awaitRenderAwareStream` 的 fallback 均复用 `renderCard`，自动获得新样式，无需单独改动。

## 9. 测试

- **快照**：更新 `tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap`，覆盖新增 header、页脚、彩色边框。快照测试需为耗时提供固定 `now`/`startedAt`，避免不稳定。
- **新增单测**：`theme` 映射（各工具类型 → 颜色、各状态 → header 模板/标题）。
- **新增单测**：`usage`/`system` 归约（累加、缺省）。
- **集成测试**：`tests/integration/bot/wake-up-rendering.test.ts` 依赖 wake-up banner 文案与正文，保持不变，应继续通过；新增断言可校验 header 存在。
- **回归**：`renderText` 快照不变；邮件脱敏测试继续通过。

## 10. 验收标准

1. 运行中的卡片顶部显示彩色 header，且颜色/标题随思考→工具→输出切换。
2. 工具面板边框按工具类型着色；失败为红色。
3. 页脚显示状态、耗时、工具次数；有模型/usage 时追加对应项。
4. 完成后 header 变绿并为"已完成"；出错变红；中断/超时分别为灰/橙。
5. ⏹ 终止按钮及其签名行为不变。
6. 现有 wake-up 集成测试与邮件脱敏行为不回归。
