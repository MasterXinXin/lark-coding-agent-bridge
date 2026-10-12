# 工作空间作业取消与回滚（实现计划）

> 依据 `docs/superpowers/specs/2026-10-12-workspace-job-cancellation-design.md`。TDD、一任务一提交、直接提交到 `main`。

## Task 1 — 进程终止原语

- 新增 `src/platform/process-kill.ts`：`isProcessAlive`、`killProcessTree`（win32 `taskkill /T /F`；POSIX `SIGKILL`；可注入依赖）。
- 测试 `tests/unit/platform/process-kill.test.ts`。
- 提交：`feat(platform): add process tree kill and liveness probe`

## Task 2 — 运行中作业账本

- 新增 `src/workspace/ledger.ts`：`ledgerPath` / `writeLedger` / `removeLedger` / `readLedger` / `listLedgerFiles`，容错解析。
- 测试 `tests/unit/workspace/ledger.test.ts`。
- 提交：`feat(workspace): add running-job ledger file`

## Task 3 — 操作上下文与回滚执行

- 新增 `src/workspace/operation-context.ts`（ALS、`Operation`、`OperationCancelledError`、`RollbackDescriptor`、`currentOperation`）。
- 新增 `src/workspace/rollback.ts`（`executeRollback`）。
- 测试 `tests/unit/workspace/rollback.test.ts`。
- 提交：`feat(workspace): add operation context and rollback executor`

## Task 4 — 操作注册表（run / cancel / reconcile）

- 新增 `src/workspace/operations.ts`（`OperationRegistry` + 默认单例 + 便捷函数）。
- 测试 `tests/unit/workspace/operations.test.ts`（含挂起 `fn` 的即时取消、假 ChildProcess kill、reconcile）。
- 提交：`feat(workspace): add operation registry with cancel and reconcile`

## Task 5 — 作业注册表 cancelled 状态

- `src/workspace/jobs.ts`：`JobStatus` 加 `'cancelled'`；新增 `cancel(jobId, detail?)`。
- 测试追加 `tests/unit/workspace/jobs.test.ts`。
- 提交：`feat(workspace): add cancelled state to job registry`

## Task 6 — 子进程登记 + beginJob 接入 op

- `src/git/git-ops.ts`、`src/workspace/codegraph.ts` 的 runner：`currentOperation()?.track(...)`，已取消则不 spawn。
- `src/workspace/git-jobs.ts`：`beginJob` 包 `defaultOperations.run`；`OperationCancelledError` → `cancel`。
- 集成测试 `tests/integration/workspace/job-cancel.test.ts`（部分）。
- 提交：`feat(workspace): track job children and route cancellation through operations`

## Task 7 — 回滚描述符接线

- `src/ui/workspace-api.ts`：`addProjects` 注册/提交 `add-checkout`。
- `src/workspace/codegraph.ts`：`init`/`sync` 注册/提交 `codegraph-init`/`codegraph-sync`。
- 集成测试 `job-cancel`：add 取消回滚目录+记录；codegraph init 取消删 `.codegraph/`。
- 提交：`feat(workspace): register rollbacks for checkout and codegraph steps`

## Task 8 — 定时拉取与 profile 停止/重启纳入

- `src/workspace/scheduler.ts`：`tick` 包 `defaultOperations.run`。
- `src/ui/server.ts`：`/api/profiles/stop` 前 `cancelByProfile`；（restart 同）。
- 测试：scheduler 单测补「取消不报错」；server 路由单测可选。
- 提交：`feat(workspace): cancel scheduled pulls and profile jobs`

## Task 9 — 取消 API + 启动对账 + 关停清理

- `src/ui/server.ts`：`POST /api/jobs/:id/cancel`。
- `src/cli/commands/start.ts`：`runClassic`/`runSupervisorConsole` 启动时 `reconcile`；`parkWithShutdown` 的 `shutdown()` 调 `cancelAll`。
- 提交：`feat(cli): reconcile stale jobs and cancel on shutdown`

## Task 10 — 前端取消按钮与已取消状态

- `web/src/lib/types.ts`：`JobStatus` 加 `"cancelled"`。
- `web/src/components/JobProgressDialog.tsx`：徽标/步骤/按钮。
- 验证 `pnpm build:web`。
- 提交：`feat(web): cancel running workspace jobs`

## 收尾

- `pnpm typecheck`、相关 vitest、`pnpm build:web` 全绿。
- 更新 README（如有必要）并推送 `origin/main`。
