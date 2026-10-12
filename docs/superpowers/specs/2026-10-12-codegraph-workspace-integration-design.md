# 控制台「CodeGraph」集成 —— 设计

- 日期：2026-10-12
- 关联：`2026-10-10-workspace-git-projects-design.md`（工作空间与 Git 项目）、`2026-10-12-console-schedule-ui-design.md`（定时拉取 UI）、`2026-10-12-git-job-progress-design.md`（后台作业进度）
- 起因：工作空间页已支持项目添加 / 定时拉取，但项目没有代码知识图谱索引。希望每个项目独立建立 CodeGraph 索引，并在控制台统一做「CLI 安装检测 → MCP 接入 → 逐项目初始化 → git 更新后增量同步」。

## 1. 目标

控制台「工作空间」页新增一张 **CodeGraph 卡片**，并让项目列表带索引状态列，使用户能：

1. 看到 CodeGraph CLI 是否安装；未安装时用**平台脚本**或 **npm** 两种方式一键安装。
2. 看到 codegraph MCP 是否已接入本机 agent；未接入时一键 `codegraph install --yes`（全 agent 写入）。
3. 新添加的项目在 clone 成功后**自动 `codegraph init`**；已存在但未索引的项目可**批量初始化**。
4. git 拉取**确有更新**时，自动对已索引项目 `codegraph sync` 增量同步。
5. 在项目行看到「已索引 / 未索引 / 不可用」状态，并能按需查看单个项目的索引统计。

## 2. 非目标

- **不做**「整个工作空间一次性索引」。多个独立仓库合并索引会出现跨仓同名符号的虚假调用边，且根目录缺少各仓库的 `.gitignore` 语义。逐项目索引是既定方向。
- **不改**会话路由与系统 prompt。codegraph MCP 由 opencode 按会话目录实例化（`cwd = 会话 directory`），路由沿用现有 `/cd`、`/ws use` 机制，本次不触碰。
- **不引入**新的持久化状态文件：索引状态全部由文件系统 + `codegraph status` 实时派生。
- **不引入**新的前端依赖，复用现有 shadcn 组件、`sonner` toast 与 `JobProgressDialog`。
- 不自动重启 bridge；MCP 接入后由卡片提示「需重启 bridge/opencode 后生效」。

## 3. 背景事实（本机实测，作为契约依据）

| 事实 | 来源 |
|---|---|
| `codegraph --version` → `0.9.9` | 实测 |
| `codegraph init [path]`（`-i` 已废弃但兼容，默认即建索引） | `codegraph help init` |
| `codegraph sync [-q] [path]` | `codegraph help sync` |
| `codegraph status [path] -j` | `codegraph help status` |
| `codegraph install [-y] [-t <ids>] [-l global\|local]`；`-y` ⇒ `--location=global --target=auto` | `codegraph help install` |
| `codegraph status --json` 返回 `{ initialized, projectPath, fileCount, nodeCount, edgeCount, dbSizeBytes, backend, journalMode, nodesByKind, languages, pendingChanges:{added,modified,removed}, worktreeMismatch }` | 实测 |
| opencode 全局 MCP 配置在 `%APPDATA%\opencode\opencode.jsonc`（mac/linux `~/.config/opencode/opencode.json`），键为 `mcp.codegraph`（旧版 `mcp.servers.codegraph`），command=`["codegraph","serve","--mcp"]` | `codegraph install --print-config opencode` |
| **坑**：对**未索引**目录执行 `codegraph status` 会卡住/交互提示（实测 60s 超时） | 实测 |

最后一条是硬约束：**行级状态一律不 spawn `codegraph status`，只用文件系统探测**；完整统计仅在项目已索引时按需拉取。

## 4. 状态模型

四个互相独立的层，每层可单独修复：

```
L1 CLI 存在？      codegraph --version                       （机器级）
L2 MCP 已接入？    解析 opencode 全局 config 的 mcp.codegraph （机器级）
L3 项目已索引？    <项目>/.codegraph/codegraph.db 存在         （项目级）
L4 初始化/同步     codegraph init / sync                     （项目级，按需 spawn）
```

- L1 缺失 → 卡片只显示安装入口，项目行标「不可用」。
- L1 有、L2 缺 → 卡片显示「接入 codegraph MCP」入口。
- L1+L2 有 → 显示版本、MCP 路径、「初始化全部未索引项目」、「全部同步」。

## 5. 后端设计

### 5.1 新模块 `src/workspace/codegraph.ts`

与 `src/git/git-ops.ts` 对称，便于注入 fake runner 做单测：

```ts
export interface CodegraphResult { code: number; stdout: string; stderr: string }
export type CodegraphRunner = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; onOutput?: (chunk: string) => void },
) => Promise<CodegraphResult>;

export function createCodegraphRunner(bin?: string): CodegraphRunner; // 默认 bin 取 LARK_CHANNEL_CODEGRAPH_BIN 或 'codegraph'

export interface CodegraphCliStatus { installed: boolean; version?: string; binaryPath?: string }
export async function detectCli(runner: CodegraphRunner, bin?: string): Promise<CodegraphCliStatus>;

export type CodegraphMcpState = 'installed' | 'missing' | 'unknown';
export interface CodegraphMcpStatus { state: CodegraphMcpState; configPath?: string }
export async function mcpStatus(): Promise<CodegraphMcpStatus>;

export interface CodegraphIndexInfo { indexed: boolean; dbPath?: string; dbSizeBytes?: number; updatedAt?: string }
export async function projectIndexInfo(dir: string): Promise<CodegraphIndexInfo>;   // 纯 fs.stat，不 spawn

export interface CodegraphStats {
  initialized: boolean; fileCount: number; nodeCount: number; edgeCount: number;
  dbSizeBytes: number; languages: string[];
  pendingChanges: { added: number; modified: number; removed: number };
}
export async function projectStats(runner: CodegraphRunner, dir: string): Promise<CodegraphStats>; // 仅 indexed 时调用

export async function initProject(runner: CodegraphRunner, dir: string, onOutput?: (c: string) => void): Promise<{ ok: boolean; detail?: string }>;
export async function syncProject(runner: CodegraphRunner, dir: string, onOutput?: (c: string) => void): Promise<{ ok: boolean; detail?: string }>;
```

要点：

- `detectCli`：先用 `resolveExecutablePath`（复用 `src/cli/agent-detection.ts`）确认可执行，再跑 `--version` 取版本。
- `mcpStatus`：跨平台解析 opencode 全局配置，候选顺序：`$OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → Windows `%APPDATA%\opencode` → `~/.config/opencode`，每个目录下先 `.jsonc` 后 `.json`。JSONC 用容错解析（去 `//`、`/* */` 注释与尾逗号后 `JSON.parse`）。命中 `mcp.codegraph` 或 `mcp.servers.codegraph` 即 `installed`；读到配置但无该键即 `missing`；文件不存在或解析失败即 `unknown`（不误报缺失）。
- `projectIndexInfo`：只 `stat(<dir>/.codegraph/codegraph.db)`，返回 `updatedAt`（mtime ISO）与大小。
- `projectStats`：仅在 `indexed === true` 时执行 `status <dir> --json`，解析为 `CodegraphStats`；解析失败降级为 `initialized:false` 错误态，不抛。

### 5.2 「作业侧挂钩」抽象（让 `workspace-api.ts` 保持解耦、可测）

```ts
export interface CodegraphHook {
  available: boolean;
  init(dir: string): Promise<{ ok: boolean; detail?: string }>;
  sync(dir: string): Promise<{ ok: boolean; detail?: string }>;
}
export function createCodegraphHook(opts?: {
  bin?: string; runner?: CodegraphRunner; onOutput?: (chunk: string) => void;
}): CodegraphHook;
```

`addProjects` / `pullProjects` 接收可选的 `codegraph?: CodegraphHook`。生产由 `git-jobs.ts`/`scheduler.ts` 注入（`onOutput` 指向作业日志），测试注入 fake。

### 5.3 HTTP 端点（沿用 localhost + token + `HttpError`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/codegraph?profile=` | 系统级：`{ cli: CodegraphCliStatus, mcp: CodegraphMcpStatus }` |
| POST | `/api/codegraph/cli/install?profile=` | body `{ method: 'script' \| 'npm' }` → 202 `{ jobId }` |
| POST | `/api/codegraph/mcp/install?profile=` | 202 `{ jobId }`（`codegraph install --yes`） |
| POST | `/api/codegraph/init?profile=` | body `{ id }` 或 `{ all: true }` → 202 `{ jobId }` |
| POST | `/api/codegraph/sync?profile=` | body `{ id }` 或 `{ all: true }` → 202 `{ jobId }` |
| GET | `/api/codegraph/project?profile=&id=` | 单项目完整统计（`projectStats`），仅 indexed 时有意义 |
| GET | `/api/projects?profile=` | 每行**新增** `codegraph: CodegraphIndexInfo`（纯 FS，无 spawn） |

安装命令：

- `script`：Windows `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"`；mac/linux `sh -c "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh"`。
- `npm`：`npm i -g @colbymchenry/codegraph`。
- 安装 job 成功后，**同一 job 内自动**再次 `detectCli`；若已装且 `mcpStatus !== 'installed'`，继续执行 `codegraph install --yes`（全 agent 写入）。再探测一次并写入 job 结果。

### 5.4 作业系统复用

- 扩展 `src/workspace/git-jobs.ts`：把 `beginJob` 的 `kind` 联合从 `'add' | 'pull'` 扩展为 `'add' | 'pull' | 'codegraph'`；新增 `startCodegraphJob(profile, rootDir, body, deps)`，按 `body.action`（`cli-install` / `mcp-install` / `init` / `sync`）分派。
- codegraph 子进程输出经与 git 相同的 `registry.append` 管道流入作业日志，前端复用 `JobProgressDialog` 实时滚动，零新增轮询逻辑。
- `StartJobDeps` 增加 `codegraphRunner?: CodegraphRunner`（测试注入）。

### 5.5 git 拉取集成（`src/ui/workspace-api.ts` `pullProjects`）

- 每个项目 `pullRepo` 后：仅当 `outcome.status === 'updated'` 且 `projectIndexInfo(dir).indexed` 时，追加 `codegraph.sync(dir)`，输出进同一 job。
- `up-to-date` / `skipped` / `fetch-only` 不同步。
- 未索引但 CLI 可用 → 记录一行提示「未索引，跳过同步（可在控制台点『初始化全部未索引项目』）」。
- `PullScheduler.runProfile` 走的仍是 `pullProjects`，因此**定时拉取也会自动同步**；`scheduler.ts` 传入不带 `onOutput` 的 hook（只写结构化日志）。

### 5.6 项目添加集成（`addProjects`）

- `ensureCheckout` 成功后，若 `codegraph?.available` → 追加 `codegraph.init(dir)`。
- init 失败**不回滚**已克隆的项目；失败信息写入 add job 日志，项目行照常显示「未索引」。
- CLI 不可用 → 跳过，项目行显示「不可用」。

## 6. 前端设计

### 6.1 `CodegraphCard`（新增，`web/src/components/CodegraphCard.tsx`）

卡片位置：`WorkspaceView` 中 `GitAccountCard` 之后、项目卡之前。内容按 L1/L2 状态分支：

- **L1 未装**：文案说明 + 安装方式 `Select`（平台脚本 / npm，默认平台脚本）+ `[安装 CodeGraph]` 按钮（`Dialog` 二次确认，说明「将通过官方安装脚本/npm 全局安装」）。点击 → `POST /api/codegraph/cli/install` → 打开 `JobProgressDialog`。
- **L1 已装、L2 未接入**：显示版本 + `[接入 CodeGraph MCP]` 按钮 → `POST /api/codegraph/mcp/install`；附提示「接入后需重启 bridge/opencode 才生效」。
- **L2 已接入**：显示版本、MCP 配置路径 + `[初始化全部未索引项目]`、`[全部同步]` 按钮（`all: true`）。
- 系统状态加载：`GET /api/codegraph?profile=`；加载失败不阻塞项目列表（沿用「history advisory」的降级策略）。

### 6.2 项目行（`WorkspaceView.ProjectRow`）

- 在仓库地址下新增一行 codegraph 徽章：`已索引`（success）/ `未索引`（secondary）/ `不可用`（destructive），有 `updatedAt` 时显示「索引更新：<时间>」。
- 行内 `[建索引]`（未索引时）/ `[同步]`（已索引时）按钮 → `POST /api/codegraph/init|sync { id }` → 同一进度弹窗。
- 展开详情（可选，「详情」按钮）→ `GET /api/codegraph/project?id=` 显示文件/节点/边数、语言、`pendingChanges`。

### 6.3 类型（`web/src/lib/types.ts`）

```ts
export interface CodegraphIndexInfo { indexed: boolean; dbPath?: string; dbSizeBytes?: number; updatedAt?: string }
export interface CodegraphCliStatus { installed: boolean; version?: string; binaryPath?: string }
export type CodegraphMcpState = "installed" | "missing" | "unknown";
export interface CodegraphMcpStatus { state: CodegraphMcpState; configPath?: string }
export interface CodegraphSystemView { cli: CodegraphCliStatus; mcp: CodegraphMcpStatus }
export interface CodegraphStats { initialized: boolean; fileCount: number; nodeCount: number; edgeCount: number; dbSizeBytes: number; languages: string[]; pendingChanges: { added: number; modified: number; removed: number } }
// ProjectView 增加：codegraph: CodegraphIndexInfo
```

## 7. 数据流

- `WorkspaceView.load()` 的 `Promise.all` 增加 `GET /api/codegraph?profile=`（系统状态，失败降级为空），项目行 codegraph 状态随 `GET /api/projects` 一次返回，无额外逐行请求。
- 任一 codegraph 作业结束时 `JobProgressDialog.onFinished` → `load()`，状态刷新。
- 项目「详情」按需请求 `/api/codegraph/project?id=`，避免页面加载时对 N 个项目 spawn N 个进程。

## 8. 错误处理与并发

- CLI 缺失：所有需要 codegraph 的按钮禁用或隐藏；`projectIndexInfo` 仍返回 `indexed` 供展示。
- 安装网络失败 / npm 失败：作业 status=failed，错误与输出在进度弹窗可见，前端 `toast.error`。
- `init`/`sync` 失败：作业日志记录，不回滚 git 状态；项目行保持「未索引」，可重试。
- 版本差异：`codegraph status --json` 字段缺失时逐字段兜底（`fileCount ?? 0` 等），不抛。
- 并发：沿用现有约定——有作业运行时禁用触发按钮（`busy || jobRunning`）；同一时刻只允许一个添加/拉取/codegraph 作业。
- 卡住防护：`init`/`sync` 给 `timeoutMs`（如 10 分钟），超时 kill 并记为失败，避免无限挂起。

## 9. 安全

- 安装 = 执行官方远程脚本 / 全局 npm，属用户点按钮触发的本地提权操作；前端 `Dialog` 二次确认，后端仍受现有 `isLocalRequest` + `checkToken` 保护。
- `codegraph install --yes` 会写入本机所有被检测到的 agent（Claude/Codex/opencode）全局配置；这是**明确决定**（本项目同时桥接 codex 等）。
- 不把 codegraph 路径或输出写入系统 prompt；作业日志沿用现有 redact 机制。

## 10. 测试

- `tests/unit/workspace/codegraph.test.ts`（fake runner，照搬 `git-jobs`/`workspace-api` 测试风格）：
  - `detectCli`：存在于缺失两种分支。
  - `mcpStatus`：`mcp.codegraph` / `mcp.servers.codegraph` / 无键 / 文件不存在 / JSONC 注释与尾逗号 五种输入。
  - `projectIndexInfo`：`.codegraph/codegraph.db` 存在/不存在。
  - **未索引目录下 `projectStats` 不 spawn `status`**（用计数 runner 断言）。
  - `projectStats` 解析真实 `status --json` 样例；字段缺失时兜底。
- `tests/integration/ui/workspace-routes.test.ts` 延伸（fake `CodegraphHook`）：
  - `pullProjects` 仅 `updated` 触发 sync；`up-to-date`/`skipped` 不触发；未索引不触发。
  - `addProjects` clone 成功后调用 init；init 抛错不影响项目记录。
- 前端无单测设施：`pnpm exec tsc --noEmit -p web/tsconfig.json` + `pnpm build`。

## 11. 验收标准

1. 控制台工作空间页出现「CodeGraph」卡片：CLI 未装时给出平台脚本 / npm 两种安装方式并可一键执行（带二次确认与进度）。
2. CLI 装完后同一作业自动执行 `codegraph install --yes`（全 agent），卡片随后显示「已接入」与配置路径，并提示重启生效。
3. 新添加项目在 clone 成功后自动 `codegraph init`；「初始化全部未索引项目」可批量补齐历史项目。
4. git 拉取**确有更新**时自动对已索引项目 `codegraph sync`；无更新/跳过时不执行。
5. 项目行显示 codegraph 状态（已索引 / 未索引 / 不可用）与「索引更新」时间；可按需查看单项目统计。
6. 不引入新依赖；`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。

## 12. 已决设计选择

1. **MCP 接入范围**：全写。执行 `codegraph install --yes`（⇒ `--location=global --target=auto`），因为本项目同时存在 codex 等桥接模式。
2. **安装方式**：平台脚本与 npm 两种都提供，默认平台脚本。
3. **同步触发**：仅当本次 pull 确为 `updated` 才 sync。
4. **自动初始化范围**：新项目自动 init + 提供「初始化全部未索引项目」批量按钮。
5. **CLI 安装后动作**：自动接 MCP（同一作业内）。
