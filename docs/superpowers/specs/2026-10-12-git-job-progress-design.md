# Git 任务实时进度（添加 / 拉取）设计

> 状态：已与用户确认范围与方案（2026-10-12）。本设计在 P2（全局 Git 账号）之上，
> 属于原 P3「执行过程可视化」的提前实现，**不含**定时任务与飞书通知。

## 1. 目标

添加项目（`git clone`）与手动拉取（`git pull`）时，用户能看到**实时执行过程**，而不是
点了按钮后页面长时间无反馈：

- 模态弹窗内滚动显示 git 的实时输出（进度行、`remote:` 消息、错误）。
- 顶部显示阶段/状态（排队 / 运行中 / 成功 / 失败）与耗时，尽可能解析出百分比进度条。
- 操作在**服务端后台**执行；用户关闭弹窗、刷新或切走标签页后再回来，仍能接着看进度/结果（可重连）。

## 2. 范围

**覆盖：**
- `POST /api/projects`（添加项目，一次可含多个仓库）。
- `POST /api/projects/pull`（拉取；全部或单个项目）。

**不做（明确排除）：**
- 定时拉取任务、失败飞书通知、执行历史持久化。
- 取消/中止进行中的任务（YAGNI；后续可加）。
- 逐个文件路径级别的输出——git 默认不逐文件打印，仅呈现 git 的进度行与 `remote:` 消息。

## 3. 关键决策（用户已确认）

| 决策 | 选择 |
|---|---|
| 覆盖操作 | 添加项目 + 手动拉取 |
| 离开页面 | 后台继续执行 + 可重连查看 |
| 界面形式 | 模态弹窗内滚动日志 |
| 传输方式 | 服务端任务注册表 + 前端轮询（方案 A） |

## 4. 架构

### 4.1 git 流式输出（`src/git/git-ops.ts`）
- `GitRunOptions` 增加 `onOutput?: (chunk: string) => void`；`createGitRunner` 在 `stdout`/`stderr`
  的 `data` 事件里回调（同时仍累积完整输出，保持既有返回契约）。
- `clone / fetch / pull` 增加 `--progress`：stderr 被管道捕获时（非 TTY）git 默认隐藏进度，
  必须显式开启。

### 4.2 任务注册表（`src/workspace/jobs.ts`，内存）
- `JobRegistry`：
  - `create({ kind, label })` → `Job`（`status: 'running'`）。
  - `append(jobId, line: { stepId?, stream: 'stdout'|'stderr'|'info', text })`：按 `\r`/`\n`
    拆成行、丢弃纯空行、累加序号 `seq`。
  - `step(jobId, { id, name })`：登记/切换当前步骤（对应一个项目）。
  - `finish(jobId, result?)` / `fail(jobId, message)`。
  - `get(jobId, since?)` → `{ status, steps, logs: seq>since, result?, error?, startedAt, endedAt }`。
  - 上限与清理：每任务日志最多 `N` 行（超出丢最旧）；任务完成后保留有限时间/数量，避免内存泄漏。
  - **安全**：写入日志前 scrub 掉账号 PAT（防御性；正常不会出现，因为 token 只走环境变量）。

### 4.3 操作包装（`src/workspace/git-jobs.ts`）
- `startAddJob(profile, rootDir, body, deps)` / `startPullJob(profile, rootDir, body, deps)`：
  创建任务 → 构造注入了 `onOutput` 的 `GitRunner` → 调用现有 `addProjects` / `pullProjects`
  → 成功 `finish(result)`、失败 `fail(err)`（添加失败沿用既有目录回滚）。
- 为把日志归属到具体项目：给 `addProjects` / `pullProjects` 增加可选 `onStep?: (info) => void`
  回调，在每个项目的 git 工作开始前调用；包装层据此设置当前 `stepId`。

### 4.4 服务端路由（`src/ui/server.ts`）
- `POST /api/projects` → 启动添加任务，**立即**返回 `202 { jobId }`。
- `POST /api/projects/pull` → 启动拉取任务，返回 `202 { jobId }`。
- `GET /api/jobs/:id?since=<seq>` → 任务快照 + 增量日志。
- 既有 `x-ui-token` 鉴权不变。

### 4.5 前端
- `web/src/lib/types.ts`：`JobStatus`、`JobStep`、`JobLogLine`、`JobView`。
- 新组件 `web/src/components/JobProgressDialog.tsx`：
  - props `{ jobId, open, onOpenChange, onFinished }`。
  - 挂载即按 ~600ms 轮询 `GET /api/jobs/:id?since=lastSeq`，增量追加日志并自动滚到底。
  - 顶部：标题、状态徽章、阶段、耗时、进度条（从日志行解析 `NN%`，解析不到用不确定态）。
  - 可滚动等宽日志区；底部「关闭」按钮（运行中关闭不中断任务）。
  - 完成时回调 `onFinished`，父组件刷新项目列表；失败时展示错误文本。
- `WorkspaceView`：`addItems` / `pull` 改为拿到 `jobId` 后打开弹窗；把最近 `jobId` 写入
  `localStorage`，页面加载时若该任务仍 `running` 则自动重开弹窗（可重连）。

## 5. 错误处理

- git 失败 → 任务 `failed`，弹窗展示错误与已捕获日志；添加失败沿用既有回滚（清理未完成目录）。
- 轮询返回 404（任务已被清理 / 进程重启）→ 弹窗提示「任务状态已丢失」并刷新列表。
- 轮询网络错误 → 短暂重试，超过阈值提示并保留已有日志。

## 6. 测试

- 单元 `tests/unit/workspace/jobs.test.ts`：分行（含 `\r`）、`since` 增量、行数上限、`finish`/`fail`、清理、日志 scrub。
- 单元 `tests/unit/git/git-ops-stream.test.ts`：`createGitRunner` 的 `onOutput` 收到 stdout/stderr 分片且最终返回值不变。
- 集成 `tests/integration/workspace/git-jobs.test.ts`：用注入 runner（主动触发 `onOutput`）启动添加/拉取任务 → 任务成功、日志按项目归属正确、失败路径 `failed`。
- 集成 `tests/integration/ui/job-routes.test.ts`：`POST` 返回 `jobId`；`GET /api/jobs/:id` 快照与 `since` 增量；鉴权。
- 前端：`pnpm exec tsc --noEmit -p web/tsconfig.json` + `pnpm build:web`（无前端单测）。

## 7. 任务拆分

1. git runner 流式输出（`onOutput` + `--progress`）。
2. `JobRegistry`。
3. 操作包装 `git-jobs`（含 `addProjects`/`pullProjects` 的 `onStep`）。
4. server 路由（返回 `jobId` + `GET /api/jobs/:id`）。
5. 前端：类型 + `JobProgressDialog` + `WorkspaceView` 接入与重连。
6. 全量校验 + README 说明。

## 8. 兼容性与风险

- `POST /api/projects`(`/pull`) 的响应从「项目视图/拉取结果」改为 `{ jobId }`：前端同步更新；
  既有 server 路由测试需相应调整（结果改由 `GET /api/jobs/:id` 提供）。
- 任务仅存内存：进程重启后进行中的任务与日志丢失，前端据此降级提示。
- Windows 上 git 进度行为一致（`--progress` 显式开启）。
