# 工作空间作业取消与回滚（设计）

> 状态：已与用户确认（2026-10-12）。目标：服务关闭、profile 停止/重启、或单作业取消时，把正在跑的工作空间作业（git 拉取 / codegraph 索引）连同子进程一起终止，并回滚半成品。

## 背景

工作空间作业走 `beginJob()` 的 fire-and-forget async，里面的 `git` / `codegraph` 子进程由 `spawnProcess` 拉起，**没有任何登记或追踪**。

- 定时任务（`PullScheduler`）的 `setInterval` 会随进程消失，且优雅关闭时显式 `scheduler.stop()`；但**已在 tick 里的** `pullProjects` 仍会继续。
- 优雅关闭（Ctrl-C / `stop`）只做 `scheduler.stop()` + 关 UI + `supervisor.shutdown()`（仅断连各 profile 的 agent），**不等待也不 kill** 正在跑的 git/codegraph，紧接着 `process.exit(0)`。
- 强制关闭（`taskkill /F` / `kill -9` / 关窗口）连钩子都不跑。

结果：Node 退出后子进程被孤儿化继续跑；并残留半成品——未完成的 clone 目录、半截 `.codegraph/`（`codegraph.db` 已生成会被误判「已索引」）。

## 决策（用户已确认）

1. 触发面：**进程退出 + profile 停止/重启 + 单作业取消按钮**，三者复用同一套 kill + 回滚。
2. 覆盖强制关闭：新增**持久化「运行中作业」账本**，下次启动对账兜底。
3. 回滚语义：按「该作业失败」回滚
   - `add` 中途被杀：删未完成 checkout 目录 **+ 撤该「添加项目」记录**；
   - `codegraph init` 中途被杀：删未完成 `.codegraph/`；
   - `codegraph sync` 中途被杀：保留索引，尽力 `codegraph unlock`；
   - `git pull --ff-only` 中途被杀：仓库内容不动（**不**自动删 `.git/index.lock`）。
4. 取消后的状态：新增 `cancelled`（UI「已取消」，与 `failed` 区分）。
5. 优雅宽限：先 `SIGTERM`，最多等 **2s**，超时 `SIGKILL` / Windows `taskkill /PID /T /F`。

## 架构

### 操作上下文（op）— `src/workspace/operation-context.ts`

`AsyncLocalStorage` 保存「当前操作」。op 持有：
- `id`（= jobId，或 `schedule:<profile>:<ts>`）、`opKind`、`label`、`profile?`、`rootDir?`、`startedAt`；
- `AbortController` 的 `signal`；
- 已登记子进程 `Map<pid, {pid,kind,startedAt,child}>`；
- 声明式回滚描述符 `Map<key, RollbackDescriptor>`。

导出 `currentOperation()`、`OperationCancelledError`、类型。

### 注册表 — `src/workspace/operations.ts`

`OperationRegistry`：
- `run(meta, fn)`：建 op → 写账本 → `als.run(op, fn)`；若被取消则抛 `OperationCancelledError`（**不等待 `fn` 结束**，`fn` 挂起时也立即翻状态）；
- `cancel(id)`：`abort` → 子进程 `SIGTERM` → 2s → 未退者 `killTree` → 逆序执行回滚 → 删账本条目 → 返回是否命中；
- `cancelAll()` / `cancelByProfile(profile)`；
- `reconcile(rootDir)`：扫描账本目录，`ownerPid` 已死的条目 → 存活子进程 `killTree` → 执行回滚 → 删文件；`ownerPid` 存活的跳过。

默认单例 `defaultOperations` 注入真实实现（kill / 回滚 / 账本）。

### 账本 — `src/workspace/ledger.ts`

按进程隔离，避免 classic 多进程互相覆盖：

```
<rootDir>/running-jobs/<ownerPid>.json
{ ownerPid, startedAt, entries: [{ id, opKind, label, startedAt, children:[{pid,kind,startedAt}], rollbacks:[...] }] }
```

本进程内存 `Map` 为单一事实源；任何变更后整体 `writeFileAtomic` 写一次；无条目时删除文件。读取容错（坏 JSON / 未知 kind 跳过）。

### 进程终止 — `src/platform/process-kill.ts`

- `isProcessAlive(pid)`：`process.kill(pid,0)`，`EPERM` 视为存活；
- `killProcessTree(pid)`：Windows `taskkill /PID <pid> /T /F`；POSIX `SIGKILL`。

### 回滚执行 — `src/workspace/rollback.ts`

`executeRollback(descriptor)`：
- `add-checkout`：`resolveProjectDir(workspaceDir, localPath)`（越界则跳过删除）→ `rm` 目录 → 从 `ProjectStore` 删记录并 `flush`；
- `codegraph-init`：`rm(dir/.codegraph)`；
- `codegraph-sync`：尽力 `codegraph unlock <dir>`，忽略失败。

## 接线

- `beginJob`（`git-jobs.ts`）：包 `defaultOperations.run({id: jobId, …})`；`OperationCancelledError` → `registry.cancel(jobId)`，否则 `fail`。
- `createGitRunner` / `createCommandRunner`：spawn 后 `currentOperation()?.track(kind, child)`；op 已取消则**不 spawn**，直接返回 `{code:-1}`。
- `addProjects`：`ensureCheckout` 前 `registerRollback('add-checkout:<id>', …)`；成功或既有失败路径都 `commitRollback`。
- `createCodegraphHook().init/sync`：前 `registerRollback('codegraph-init|sync:<dir>', …)`，成 `commitRollback`。
- `PullScheduler.tick`：`runProfile` 包 `defaultOperations.run({id:'schedule:…', profile})`（不产生可见 job）。
- `server.ts`：`POST /api/jobs/:id/cancel` → `cancelOperation(id)`；`/api/profiles/stop`（及 restart 前）→ `cancelByProfile`。
- `start.ts`：启动时 `reconcile(rootDir)`；`shutdown()` 中 `scheduler.stop()` 后 `cancelAll()` 再 `process.exit(0)`。
- `JobRegistry`：新增 `JobStatus='cancelled'`、`cancel(jobId, detail?)`（把 running 步骤标 cancelled）。
- 前端：`JobStatus` 加 `"cancelled"`；`JobProgressDialog` 增「取消任务」按钮（`POST /api/jobs/:id/cancel`）与已取消徽标。

## 边界与安全

- 只删**严格位于工作空间内**的目录；越界/根目录拒绝。
- pid 复用防护：对账时跳过 `ownerPid` 存活的文件、跳过 `pid === process.pid`。
- 账本写失败仅告警，不影响作业。
- 不自动删除 `.git/index.lock`。

## 测试

- 单测 `process-kill`：存活探测；win32/POSIX 分支（注入 kill/spawnSync）。
- 单测 `ledger`：写/读/列/删；坏 JSON 容错。
- 单测 `operations`：`currentOperation` 作用域；`register/commit/cancel` 回滚顺序；子进程 kill（假 ChildProcess）；`run` 被取消抛错且不等挂起的 `fn`；`reconcile`（死 owner 杀子+回滚+删文件，活 owner 跳过）。
- 单测/集成 `jobs`：`cancel()` 状态。
- 集成 `job-cancel`：codegraph init 作业挂起 → 取消 → 状态 `cancelled`、`.codegraph/` 被删；add 作业取消 → 目录 + 记录回滚。
- 前端 `pnpm build:web` 通过。
