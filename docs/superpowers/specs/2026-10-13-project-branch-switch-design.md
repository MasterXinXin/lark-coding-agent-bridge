# 工作空间项目分支切换（下拉框 + 立即切换联动） —— 设计

- 日期：2026-10-13
- 关联：`2026-10-10-workspace-git-projects-design.md`（工作空间与 Git 项目）、`2026-10-12-codegraph-workspace-integration-design.md`（CodeGraph 索引）、`2026-10-12-workspace-job-cancellation-design.md`（作业取消与回滚）
- 起因：控制台「工作空间」页里，项目的分支是一个自由文本输入框，且改分支只写 `projects.json`、不切换工作区。用户希望：**分支改为下拉框（选项 = 该仓库已有的分支）**；**分支变更时立即切换工作区，并联动定时拉取与 CodeGraph 索引更新**。

## 1. 目标

1. 项目行的分支从文本框改为**下拉框**，选项来自该仓库的远程分支（用本地 `git ls-remote`，不要求项目绑定 Git 账号），当前分支在列且置顶。
2. 选中新分支后**立即切换工作区**（`git fetch --prune` + `git checkout <branch>`）：
   - 工作区有未提交改动时**拒绝切换**，保留原分支并给出明确原因（不自动 stash、不强切）。
   - 切换成功后持久化分支名。
   - 若 CLI 已装、该项目**已索引**，切换后做一次 `codegraph sync` 增量更新。
3. **定时拉取**跟随配置分支：拉取前若「当前检出分支 ≠ 配置分支」且工作区干净，先切换再拉（`fetch-only` 策略除外，见 §5.3）。
4. 复用现有作业/进度/取消/回滚基座，分支切换做后台作业：有进度弹框、可取消，取消时回滚到原分支。

## 2. 非目标

- 不自动 stash、不 `reset --hard` 强行切换脏工作区；不提供「丢弃改动」按钮。
- 不改动「添加项目」弹框（已是「有分支下拉、拿不到退化输入框」的模式）。
- 不改拉取策略本身（`ff-only` / `fetch-only` / `reset-hard` 语义不变）。
- 不引入新依赖；不新增持久化状态文件（沿用 `projects.json`；作业/账本沿用现有 `running-jobs/`）。
- 不做「切换分支即重新 clone」。

## 3. 背景与现状

| 事实 | 位置 |
| --- | --- |
| 项目行分支是自由文本 `Input`，失焦即提交 | `web/src/views/WorkspaceView.tsx` `ProjectRow` |
| `POST /api/projects/branch` 同步返回 `ProjectsView` | `src/ui/server.ts` |
| `updateProjectBranch` 仅 `store.updateBranch(id, branch)` + flush，**不切换工作区** | `src/ui/workspace-api.ts` |
| `pullRepo` 对**当前检出分支**执行 `pull --ff-only` / `reset --hard origin/<当前分支>` | `src/git/git-ops.ts` |
| 分支列表能力仅走平台 API，需账号且仅 GitHub/GitLab/Gitea | `src/ui/git-api.ts` `branchesView` → `src/git/providers.ts` `listBranches` |
| 作业基座：kind/label、进度、取消、回滚描述符、按进程账本、启动对账 | `src/workspace/{git-jobs,jobs,operations,operation-context,rollback,ledger}.ts` |

结论：现状下「改分支名」对定时拉取几乎无影响（拉取不看配置分支）；分支列表在无账号/自建仓库下拿不到。本次一并修正。

## 4. 行为定义

- **配置分支**：`projects.json` 中项目的 `branch` 字段。
- **当前分支**：检出目录里 `git rev-parse --abbrev-ref HEAD` 的结果。
- **切换**：把工作区从当前分支切到目标分支，并使二者一致。
- **联动**：
  - *索引联动*：切换实际改变了工作区内容时，对已索引项目执行 `codegraph sync`；失败只告警，不回滚已成功的切换（与现有「拉取确有更新才 sync，且 sync 失败不影响拉取」一致）。
  - *拉取联动*：定时/手动拉取前，若配置分支与当前分支不一致且工作区干净，先切换再拉。

## 5. 后端设计

### 5.1 `src/git/git-ops.ts` 新增

```ts
/** 远程分支名（`git ls-remote --heads <repoUrl>`，解析 refs/heads/*）。失败抛错。 */
export async function listRemoteBranches(
  run: GitRunner,
  repoUrl: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string[]>;

/** 本地分支名（`git branch --format=%(refname:short)`）；非 git 目录返回 []。 */
export async function listLocalBranches(run: GitRunner, dir: string): Promise<string[]>;

/** fetch --prune + checkout <branch>（不存在则 DWIM 创建跟踪分支）。失败抛错。 */
export async function switchBranch(
  run: GitRunner,
  dir: string,
  branch: string,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<void>;
```

- `switchBranch` 先 `fetch --prune --progress`（复用 120s 超时），成功后再 `checkout <branch>`。
- 失败信息复用 `failureDetail`，分别产出 `git fetch 失败：…` / `git checkout 失败：…`。
- `listRemoteBranches` 用 60s 超时；`--` 分隔 URL，避免 URL 被当作选项。

### 5.2 `src/ui/workspace-api.ts`

新增视图与函数：

```ts
export interface ProjectBranchesView {
  branches: string[];
  current?: string;
}

/** 列某项目仓库的分支：远程 ∪ 本地 ∪ 当前，当前置顶、其余按字母。 */
export async function projectBranchesView(
  profile: string,
  rootDir: string | undefined,
  id: string,
  runner: GitRunner = run,
): Promise<ProjectBranchesView>;

/** 分支切换作业体：脏树拒绝 → fetch+checkout → 持久化 → 视情况 codegraph sync。 */
export async function switchProjectBranch(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
  codegraph?: CodegraphHook,
): Promise<ProjectsView>;
```

`projectBranchesView`：`current` 取「检出目录的当前分支」（仓库存在时）；未检出时退化为 `entry.branch`。分支集合为 `unique(远程 ∪ 本地 ∪ [current, entry.branch])`，过滤空串；排序时 `current` 置顶、其余 `localeCompare`。`ls-remote` 失败 → 400 + detail（前端据此退化输入框）。

`switchProjectBranch` 步骤：

1. 解析 `id`（缺省 400）、`branch`（trim，缺省 400），`statePaths` 取 store/workspaceDir，`store.get(id)` 缺失 404。
2. `accountUsernames` + `gitEnvForAccount` 得到 `env`（私有库需要）。
3. `dir = resolveProjectDir(...)`；`isGitRepo` 为假 → 抛错「目录不存在或不是 git 仓库，请先完成检出」。
4. `status = repoStatus(run, dir)`；`current = status.branch`。
5. `current === branch`：只需（必要时）持久化分支名，直接成功返回，**不切换、不 sync**。
6. `status.dirty` 为真 → 抛错「工作区有未提交改动，已取消切换」（旧分支保持不变）。
7. `onStep?.({ id, name })`，登记进度步骤。
8. `op = currentOperation()`；`op.registerRollback('branch-switch:<id>', { kind:'branch-switch', dir, previousBranch: current ?? '' })`。
9. `await switchBranch(run, dir, branch, { env })`；成功后 `op.commitRollback(...)`。
10. `withProjectStore` → `store.updateBranch(id, branch)` + flush（切换成功后才写；写失败不回滚已切换的工作区，下次拉取会自愈）。
11. 若 `codegraph?.available && (await projectIndexInfo(dir)).indexed`：注册 `codegraph-sync` 回滚 → `codegraph.sync(dir)`；失败 `log.warn('workspace','codegraph-sync-failed', …)`，不影响成功。
12. 返回 `projectsView(profile, rootDir)`。

> 注意：git 操作在两段 `withProjectStore` 之外执行，**不长时间持有 `projects.json` 文件锁**。

删除原先只写元数据的 `updateProjectBranch`（其唯一调用点改为新作业；集成测试同步改写）。

### 5.3 定时/手动拉取跟随分支（`pullProjects`）

在 `isGitRepo` 通过之后、执行策略之前插入：

```
const status = await repoStatus(projectRun, dir).catch(() => undefined);
if (schedule.strategy !== 'fetch-only' && project.branch && status?.branch && status.branch !== project.branch) {
  if (status.dirty) {
    result = 'skipped';
    detail = `有未提交改动，无法切换到 ${project.branch}`;
  } else {
    await switchBranch(projectRun, dir, project.branch);   // 失败则走既有 catch → failed
  }
}
```

- `fetch-only` 明确**不**切换工作区（该策略语义是只取不合并/不动工作区）。
- 切换成功后继续原有：`ensureCodegraphExcluded` → `pullRepo` → 「确有更新才 `codegraph sync`」。

### 5.4 作业与回滚扩展

- `src/workspace/git-jobs.ts`
  - `WorkspaceJobKind` 增加 `'branch'`。
  - `startBranchJob(profile, rootDir, body, deps)`：label 取 `切换分支：<branch>`（无 branch 用 `切换分支`）；`work` 创建 codegraph hook（非 `add`，故会探测）并调用 `switchProjectBranch`。
- `src/workspace/operation-context.ts`：`RollbackDescriptor` 增加 `| { kind: 'branch-switch'; dir: string; previousBranch: string }`。
- `src/workspace/rollback.ts`：处理 `branch-switch` —— best-effort `git checkout <previousBranch>`（`previousBranch` 为空则跳过）；失败只 `log.warn`。新增可注入 `switchBack?: (dir, branch) => Promise<void>`（默认真实 git `checkout`）。
- `src/workspace/ledger.ts`：`normalizeRollback` 解析 `branch-switch`（要求 `dir`、`previousBranch` 为 string）。

### 5.5 路由（`src/ui/server.ts`）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/projects/branches?profile=&id=` | 200 `ProjectBranchesView` |
| `POST` | `/api/projects/branch` | **202 `{ jobId }`**（改为后台作业；契约变更已确认） |

## 6. 前端设计（`web/src/views/WorkspaceView.tsx`）

- `ProjectRow` 的分支控件改为：
  - 挂载时 `GET /api/projects/branches?profile=&id=` 拉取列表（每个项目一次）。
  - 成功且有选项 → `Select`（当前值 = `project.branch`；选项含当前值兜底一项）。
  - 失败或空 → 退化为原来的 `Input`（手动输入，失焦提交），并提示可重试。
  - 提供一个小「刷新」按钮重新拉取。
- 提交统一走 `switchBranch(id, branch)`：`POST /api/projects/branch` → `{ jobId }` → 写 `activeJobKey`、打开共享 `JobProgressDialog`；完成后 `load()` 刷新（现有 `onFinished` 已负责）。
- `JobProgressDialog.kindLabel` 增加 `branch → 切换分支`。

## 7. 错误处理

| 场景 | 结果 |
| --- | --- |
| 项目不存在 / 无 id / 无 branch | 404 / 400 |
| 未检出（非 git 目录） | 作业失败，提示先完成检出 |
| 工作区脏 | 作业失败「工作区有未提交改动，已取消切换」，保留原分支 |
| 目标分支 == 当前分支 | 直接成功（不 fetch、不 sync），必要时更新元数据 |
| `fetch`/`checkout` 失败（网络/权限） | 作业失败，捕获原始 git 错误尾行 |
| 切换成功但 `codegraph sync` 失败 | 切换仍算成功；日志告警，项目行显示索引未更新 |
| 切换途中被取消 | 回滚切回 `previousBranch`（best-effort） |
| 拉取前切换到配置分支失败 | 该行 `failed`，detail 为 git 错误 |

## 8. 测试计划

- 单元
  - `tests/unit/.../git-ops`：`listRemoteBranches` 解析、`switchBranch` 命令序列/失败传播（recording runner）。
  - `tests/unit/workspace/rollback.test.ts`：`branch-switch` best-effort 切回（注入 `switchBack`）。
  - `tests/unit/workspace/ledger.test.ts`：`normalizeRollback` 解析 `branch-switch`。
- 集成
  - `tests/integration/workspace/branch-switch.test.ts`（新建）：本地 bare origin 多分支；
    - `projectBranchesView` 返回远程∪本地、当前置顶；
    - 切换成功 → 工作区在目标分支、`projects.json` 已更新、已索引项目触发一次 `codegraph.sync`；
    - 脏工作区 → 失败且仍在原分支；
    - 目标 == 当前 → 不 fetch/不 sync；
    - 取消 → 回滚回原分支；
    - `pullProjects` 在配置分支漂移时先切换再拉；`fetch-only` 不切换。
  - `tests/integration/ui/workspace-routes.test.ts`：`GET /api/projects/branches` 200；`POST /api/projects/branch` 202 + jobId。
  - 更新 `tests/integration/ui/workspace-api.test.ts`：原 `updateProjectBranch` 用例改走 `switchProjectBranch`/作业。
- 前端无单测设施：`tsc -p web/tsconfig.json` + `pnpm build:web` 校验。

## 9. 验收标准

1. 项目行分支为下拉框，选项为该仓库的远程分支（离线/无权限时退化输入框），当前分支置顶。
2. 选新分支后立即切换工作区；脏工作区被拒绝且保留原分支。
3. 切换成功后 `projects.json` 分支更新；已索引项目触发一次增量 `codegraph sync`。
4. 定时/手动拉取（非 `fetch-only`）在分支漂移且工作区干净时先切换再拉。
5. 分支切换是后台作业：有进度/可取消；取消时 best-effort 切回原分支。
6. 不引入新依赖；`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。

## 10. 已决设计选择

1. **分支列表来源**：本地 `git ls-remote --heads`（∪ 本地分支），不依赖账号平台支持；私有库沿用账号 env 提供凭据。
2. **切换语义**：立即切换工作区并联动（用户确认）。
3. **脏工作区**：拒绝切换、保留原分支，不自动 stash/强切。
4. **拉取联动**：保留「拉取前自动按需切换」（用户确认）；`fetch-only` 例外。
5. **接口契约**：`POST /api/projects/branch` 改为 202 + jobId（用户确认）。
6. **codegraph sync 时机**：仅在实际发生分支切换、且 CLI 可用、且项目已索引时执行；失败不回滚切换。
