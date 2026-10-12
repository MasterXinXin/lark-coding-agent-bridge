# 控制台「定时拉取」与「拉取记录」UI —— 设计

- 日期：2026-10-12
- 关联：`2026-10-10-workspace-git-projects-design.md` §9（控制台 UI，第 ④ 张卡片）、§15（验收标准 5）
- 起因：P3 实现了后端调度器与 API（`GET/POST /api/schedule`、`GET /api/pull-history`）与斜杠命令，但**控制台网页漏做了**「定时更新 + 执行记录」卡片，导致用户在控制台看不到「拉取频率」配置与「结果日志」。

## 1. 目标

在控制台「工作空间」页补齐既定设计中的第 ④ 张卡片及其执行记录，使用户能：

1. 查看并修改 profile 级定时拉取：启用/停用、间隔（分钟）、策略、失败通知。
2. 手动触发一次「立即拉取全部」。
3. 查看最近的拉取执行记录（定时与手动都在内），含结果与详情。
4. 在项目列表中看到每个项目的「最后拉取」时间。

## 2. 非目标

- 不改动后端：端点与契约均已存在并有集成测试。
- 不做「每仓库独立计划」（沿用既定设计：profile 级单一计划）。
- 不改 `/config` 卡片（已按用户决定改为红色提示 + 控制台链接）。
- 不引入新的 UI 依赖（复用现有 shadcn 组件与 sonner toast）。

## 3. 数据契约（已存在）

- `GET /api/schedule?profile=` → `PullSchedule`
  `{ enabled: boolean; intervalMinutes: number(5–1440, 默认 30); strategy: 'ff-only'|'fetch-only'|'reset-hard'(默认 'ff-only'); notifyOnFailure: boolean(默认 true) }`
- `POST /api/schedule?profile=` body=`Partial<PullSchedule>` → 合并并归一化后返回完整 `PullSchedule`。
- `GET /api/pull-history?profile=&limit=` → `{ records: PullRecord[] }`（新→旧，limit 1–500，默认 50）。
- `PullRecord = { ts: string(ISO); projectId; name; branch; result: 'updated'|'up-to-date'|'skipped'|'failed'; detail; durationMs; trigger: 'schedule'|'manual' }`
- `ProjectsView` 已包含 `schedule`（`GET /api/projects`），`ProjectView.lastPullAt` 已存在。

## 4. UI 结构（`web/src/views/WorkspaceView.tsx` 及子组件）

卡片顺序：① 工作空间目录 ② **定时拉取（新增）** ③ Git 账号 ④ 项目 ⑤ **拉取记录（新增）**。

> 说明：设计文档原文写作 ①目录 ②账号 ③项目 ④定时；此处把「定时拉取」上移到紧邻目录之后，让配置项集中在上、数据表在下，阅读更顺。功能不变。

### 4.1 `ScheduleCard`（新增组件）

- 标题「定时拉取」，右上角 `Switch` 启用/停用。
- 一行：间隔 `Input`（数字，分钟，5–1440，失焦/提交时夹取）+ 快捷预设按钮 `15 / 30 / 60 / 120` 分钟。
- 一行：策略 `Select`：`ff-only`（仅快进，推荐）/ `fetch-only`（只抓取不合并）/ `reset-hard`（强制对齐远端）。
- 一行：失败时通知 owner `Switch`。
- 操作：`[保存]`（脏时才可用）→ `POST /api/schedule`；`[立即拉取全部]` → 复用父级 `pull()`（走既有的进度弹窗）。
- 辅助文案：显示「上次定时拉取：<本地时间>」；未启用时说明「关闭时不自动拉取」。

### 4.2 `PullHistoryCard`（新增组件）

- 标题「拉取记录」+ `[刷新]`。
- 空态：「暂无记录，点「立即拉取全部」或开启定时任务后会出现。」。
- `Table` 列：时间 / 项目 / 分支 / 结果 / 触发 / 详情。
- 结果用 `Badge`：`updated`=success「已更新」、`up-to-date`=secondary「已最新」、`skipped`=secondary「已跳过」、`failed`=destructive「失败」。
- 触发列：`schedule`→「定时」、`manual`→「手动」。
- 记录里 `detail` 可能较长，单元格截断显示（`title` 属性给全文）。

### 4.3 项目行

- 在项目行的仓库地址下补「最后拉取：<时间>」（`ProjectView.lastPullAt`）；无则显示「—」。

## 5. 数据流

- `WorkspaceView.load()` 的 `Promise.all` 增加 `GET /api/pull-history?profile=&limit=50`，一次请求供两张卡片共用。
- `lastScheduledAt` 由 `records.find(r => r.trigger === 'schedule')?.ts` 得出（新→旧）。
- 保存计划：`POST /api/schedule` 返回完整计划，直接就地更新 `view.schedule`，并 toast「已保存定时拉取设置」。
- 每次任务结束（`JobProgressDialog.onFinished`）与「刷新」按钮都调用 `load()`，记录与「最后拉取」随之刷新。
- `intervalMinutes` 在提交前夹取到 `[5, 1440]`；非法输入回退为原值。

## 6. 错误处理

- 加载失败：沿用现有「加载失败：<msg>」提示。
- 保存/拉取失败：`toast.error(msg)`，不改动本地状态。
- 后端已保证 `intervalMinutes` 与 `strategy` 的归一化，前端夹取只是体验优化。

## 7. 验证

- 前端无单测设施，验证走：`pnpm exec tsc --noEmit -p web/tsconfig.json` 与 `pnpm build`（构建内联进 `dist/cli.js`）。
- 后端端点已有集成测试（`tests/integration/ui/workspace-routes.test.ts` 等），本次不改后端。
- 人工验收：重启 bridge → 硬刷新控制台 → 配置间隔/策略/开关并保存 → 触发「立即拉取全部」→ 记录表出现新行、项目行「最后拉取」更新。

## 8. 验收标准

1. 控制台可见「定时拉取」卡片，能开关、改间隔、选策略、切失败通知并保存；刷新后设置保持。
2. 控制台可见「拉取记录」卡片，展示最近 50 条，含时间/项目/分支/结果/触发/详情，可刷新。
3. 每次定时或手动拉取都会出现在记录里；项目行显示「最后拉取」时间。
4. 不引入新依赖；`tsc`（web）与 `pnpm build` 通过。
