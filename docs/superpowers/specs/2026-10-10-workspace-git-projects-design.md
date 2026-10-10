# 工作空间与 Git 项目管理设计

- 日期：2026-10-10
- 状态：已与用户确认（信息架构、账号弹框、`/config` 卡片形态均已过目认可）
- 范围：控制台（web-ui）+ 飞书 `/config` 卡片的工作空间目录选择、Git 账号、多项目/分支管理、定时拉取与执行记录
- 方案：方案 A —— 复用现有控制台与 supervisor，新增 `src/git/` 与 `src/workspace/` 模块

## 1. 背景与目标

现有 bridge 已有 per-profile 的工作目录（`workspaces.default`，由启动参数 `--workspace` 落定）与 `/ws`、`/cd` 等聊天命令，但在控制台与卡片里**没有可视化配置**，也不具备"多仓库 + 分支 + 定时拉取"的工程化管理能力。

本设计新增一套"工作空间与项目"能力：

- 在控制台以弹框浏览本机磁盘，直观选择工作空间根目录（默认填充 `--workspace` 落定的值，可改）。
- 配置 Git 账号（GitHub / 自建 GitLab / Gitea / 其他），支持自动拉取仓库列表或手填仓库地址。
- 多项目管理：每个项目可选分支、查看同步状态、手动拉取。
- 定时任务：由 supervisor 按间隔拉取各项目最新代码，可配、可开关，并有执行记录可查。
- 以上在控制台与 `/config` 卡片均可配置（卡片为"查看 + 常用编辑"，敏感 token 仅控制台）。

### 目标

- 控制台新增「工作空间」页：目录选择弹框、账号管理、项目列表（含分支）、定时任务与执行记录。
- 全局 Git 账号（机器级一份）+ 加密存储 token。
- 仓库列表自动获取（大厂/自建 GitLab/Gitea）与手动地址两种添加方式。
- supervisor 级定时拉取，含并发保护、超时、脏工作区跳过、失败通知。
- `/config` 卡片新增区块与按钮；新增若干斜杠命令。
- 全链路单元 + 集成测试。

### 非目标

- 不做 Git 仓库的托管/推送/合并/冲突自动解决；只做"拉取更新"。
- 不接入 GitHub OAuth App（用户选定 PAT）。
- 不改动 `@larksuite/channel` 的协议与消息管线。
- 不在飞书卡片里做本地磁盘目录浏览（退化为文字路径）。
- 不自动迁移或删除既有项目目录。
- 不实现"每个仓库独立定时计划"（先做 profile 级单一计划；后续可扩展）。

## 2. 术语与已确认的范围决策

- **工作空间根目录**：一个本地目录，项目仓库默认克隆/关联在其下。等价于 profile 的 `workspaces.default`。
- **项目**：一个 Git 仓库在工作空间中的一份检出，绑定一个分支。
- **Git 账号**：访问远端代码平台的凭据（PAT），**全局共享**（机器级一份）。
- **定时任务**：profile 级的一份拉取计划（间隔 + 策略），由 supervisor 统一调度。

已确认决策：

| 决策点 | 结论 |
|---|---|
| 归属范围 | 工作空间/项目/定时任务 **按 profile**；Git 账号 **全局共享** |
| Git 登录 | **PAT**（GitHub/自建通用） |
| 定时任务运行位置 | **supervisor 统一调度**（profile 离线也拉） |
| 本地有未提交改动 | **跳过并记录**，绝不覆盖 |
| 拉取结果通知 | **仅失败时**给 owner 发飞书消息 |
| `/config` 卡片能力 | **查看 + 常用编辑**（token 等敏感项在控制台） |
| 交付 | 分 3 期（见 §13） |

## 3. 系统架构

```
┌─────────────────────── supervisor 进程（lark-channel-bridge start --web-ui）───────────────┐
│  ui/server.ts（HTTP + token 鉴权）                                                          │
│      ├── /api/git/*        → src/git/accounts.ts, providers.ts, git-ops.ts                  │
│      ├── /api/projects     → src/workspace/projects.ts                                      │
│      ├── /api/workspace/dir→ src/workspace/dir-browse.ts                                    │
│      ├── /api/schedule     → src/workspace/projects.ts（schedule 段）                       │
│      └── /api/pull-history → src/workspace/history.ts                                       │
│  runtime/supervisor.ts（管理各 profile 在线状态、channelFor/controlsFor）                    │
│  workspace/scheduler.ts（单例定时器；遍历所有 profile 的启用任务执行拉取）                    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        │ 复用                                        │ 复用
        ▼                                              ▼
  src/commands + src/card（/config 卡片与回调）    src/config/keystore.ts（主机级密钥）
```

- 定时器与全部新 API 均寄居 supervisor；单 profile headless 运行时这些 API 不可用（控制台本就要求 `--web-ui`）。
- 前端沿用 `web/` 现有 Vite + React + shadcn 风格，产物经 `vite-plugin-singlefile` 内联进 CLI。

### 新增模块清单

| 文件 | 职责 |
|---|---|
| `src/git/accounts.ts` | 全局账号 CRUD；元数据 + 主机级密钥读写 |
| `src/git/providers.ts` | 平台适配：URL/类型识别、调 API 列仓库、分支列表 |
| `src/git/git-ops.ts` | `git` CLI 包装：clone / fetch / status / pull / 分支 |
| `src/workspace/projects.ts` | per-profile 项目清单 + 计划配置的读写与规范化 |
| `src/workspace/dir-browse.ts` | 服务端目录浏览（选择器数据源） |
| `src/workspace/scheduler.ts` | 定时任务单例与单轮执行逻辑 |
| `src/workspace/history.ts` | 执行记录追加/读取/截断 |
| `web/src/views/WorkspaceView.tsx`（及子组件） | 控制台「工作空间」页 |

## 4. 数据模型与落盘

### 4.1 全局 Git 账号（机器级）

`~/.lark-channel/git-accounts.json`（0600）：

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "id": "gh-1",                 // 随机短 id
      "label": "GitHub",            // 用户可读名
      "provider": "github",         // github | gitlab | gitea | other
      "baseUrl": "https://api.github.com", // API 基址（other 时可为空）
      "username": "masterxinxin",   // 可选，展示用
      "tokenRef": "git-account:gh-1" // 密钥 id，明文不落此文件
    }
  ]
}
```

- token 明文存入**主机级** keystore：`~/.lark-channel/secrets.enc`，键 `git-account:<id>`。
- 现有 `keystore.ts` 的函数已支持传入自定义 `storePaths`，新增 `AppPaths.hostSecretsFile` / `hostKeystoreSaltFile` 指向根目录，无需改加密实现。
- 列表/详情接口**永不返回 token**，只返回 `hasToken: true`。

### 4.2 per-profile 项目与计划

`~/.lark-channel/profiles/<profile>/projects.json`（0600）：

```jsonc
{
  "version": 1,
  "projects": [
    {
      "id": "p1",
      "name": "backend-api",
      "repoUrl": "git@git.company.com:team/backend.git",
      "localPath": "backend-api",   // 相对工作空间根；也允许绝对路径
      "branch": "develop",
      "accountId": "gh-1"           // 可选：用于私有仓库拉取鉴权
    }
  ],
  "schedule": {
    "enabled": true,
    "intervalMinutes": 30,          // 5–1440
    "strategy": "ff-only",          // ff-only | fetch-only | reset-hard
    "notifyOnFailure": true
  }
}
```

- 工作空间根目录**继续使用** `profiles/<p>` 的 `config.json → workspaces.default`，不新增存储（这样与既有 `/cd`、`/ws`、`--workspace` 语义一致）。
- `localPath` 为相对路径时解析为 `工作空间根 / localPath`；校验后必须落在工作空间根之内（防止越界），绝对路径仅允许在工作空间根之外时显式确认（P1 先只支持根内相对路径，降低风险）。
- 项目规范：`name` 非空且在同一 profile 内唯一；`repoUrl` 非空；`branch` 默认 `main`。

### 4.3 执行记录

`~/.lark-channel/profiles/<profile>/pull-history.jsonl`（JSON Lines，追加写，超 500 行自动截断）：

```jsonc
{ "ts":"2026-10-10T14:00:12.000Z", "projectId":"p1", "name":"backend-api",
  "branch":"develop", "result":"updated", "detail":"fast-forward 2 commits",
  "durationMs":2800, "trigger":"schedule" }
```

- `result`：`updated` | `up-to-date` | `skipped` | `failed`。
- `trigger`：`schedule` | `manual`。
- 读取接口按时间倒序返回，`limit` 默认 50。

## 5. Git 账号与 Provider 适配（`src/git/providers.ts`）

### 5.1 识别与 API

| provider | 列仓库接口 | 分页 | 备注 |
|---|---|---|---|
| `github` | `GET {base}/user/repos?per_page=100&sort=updated` | Link header | base 默认 `https://api.github.com` |
| `gitlab` | `GET {base}/api/v4/projects?membership=true&per_page=100` | `x-next-page` | base 为站点根，如 `https://gitlab.com` |
| `gitea` | `GET {base}/api/v1/user/repos?limit=50` | `page` | base 为站点根 |
| `other` | 不支持列仓库 | — | 仅手动地址 |

- 分支列表：GitHub/GitLab/Gitea 均有对应 branches API；失败时降级为"手动输入分支"。
- 统一返回 `{ id, name, fullName, cloneUrl(https/ssh), defaultBranch, private }`。
- 认证：`Authorization: Bearer <token>`；GitLab 用 `PRIVATE-TOKEN`。
- 超时与错误：统一 10s 超时；401/403 映射为"令牌无效或权限不足"；网络错误原样透出。

### 5.2 用 PAT 拉取代码

- 克隆/拉取私有仓库时，通过 `GIT_ASKPASS`/临时 `credential.helper` 或 URL 注入注入 token，**避免 token 出现在进程命令行**（用环境变量 + `GIT_CONFIG_*`，见 §11）。
- 公开仓库无账号也可拉取。

## 6. 工作空间与项目

### 6.1 目录浏览（`src/workspace/dir-browse.ts`）

- 输入一个路径（空 = 默认：Windows 列盘符，mac/Linux 从家目录或 `/`），返回该目录下的子目录列表 + 当前路径 + 父路径。
- 仅列目录（是否显示文件可选），不读取文件内容。
- 复用 `src/policy/workspace.ts` 的路径校验思路（存在、是目录、非过宽）。
- 仅 supervisor 本机可访问（沿用 `isLocalRequest` + token）。

### 6.2 添加项目

- **从账号添加**：调 provider 列仓库 → 勾选若干 + 每个选分支 → 批量创建项目；`localPath` 默认 = 仓库名。
- **手动添加**：填 `repoUrl` + 分支 +（可选）账号 → 创建项目。
- 创建后的落地策略（`git-ops.ensureCheckout`）：
  - 目标目录不存在 → `git clone --branch <branch> <repoUrl> <dir>`。
  - 目标目录存在且是 git 仓库 → 关联（校验 remote 与 repoUrl 是否一致，不一致则警告）。
  - 目标目录存在但非空且非 git 仓库 → 报错，不覆盖。
- 支持在列表里改分支、移除项目（移除仅从清单删除，**不删除磁盘目录**）。

### 6.3 状态

每个项目可查询：当前分支、是否 dirty（有未提交改动）、ahead/behind 计数、最后拉取时间（取 history 最新一条）。

## 7. 定时任务与执行记录（`src/workspace/scheduler.ts`）

- supervisor 启动时创建**单例** `PullScheduler`；即使无启用任务也常驻（惰性 tick）。
- 每 tick（基础粒度 1 分钟）：
  1. 重读磁盘：根 config + 各 profile 的 `projects.json`。
  2. 对每个 `schedule.enabled` 的 profile，判断是否到点（`now - lastRun >= intervalMinutes`）。
  3. 串行（或小并发）对每个项目执行 `git-ops.pull`。
  4. 写 history；失败且 `notifyOnFailure` 且 profile 在线 → 发飞书消息给 owner。
- 保护：`running` 标志防重入；单仓库超时（默认 60s）；`git` 不存在时跳过整轮并在记录中标注。
- 策略语义：
  - `ff-only`（默认）：fetch 后 `git pull --ff-only`；非快进则记 `failed`。
  - `fetch-only`：只 `git fetch`，不动工作区。
  - `reset-hard`：`git fetch` + `git reset --hard origin/<branch>`（用户在 UI 显式选择才生效）。
- **dirty 检测优先**：任何策略下，若工作区有未提交改动（`ff-only`/`reset-hard` 会覆盖），记 `skipped` 并跳过；`fetch-only` 不受影响。
- 「立即拉取」：通过 API/卡片触发一次 ad-hoc 执行，`trigger:"manual"`，不影响定时计划的 lastRun。

## 8. 控制台 API（`src/ui/server.ts` + `src/ui/api.ts`）

沿用现有鉴权（本地 + token）与 `HttpError` 风格：

```
GET    /api/git/accounts                     列出账号（无 token）
POST   /api/git/accounts                     新增/更新账号（含 token，可空表示不修改）
DELETE /api/git/accounts?id=                 删除账号（同时删密钥）
POST   /api/git/accounts/test                测试连接，返回 { ok, username?, repoCount? }
GET    /api/git/repos?account=&query=        列仓库（分页）
GET    /api/git/branches?account=&repo=      列分支

GET    /api/workspace/dir?path=              目录浏览
GET    /api/projects?profile=                项目列表（含状态/最后拉取）
POST   /api/projects?profile=                新增项目（单个/批量）
POST   /api/projects/branch?profile=         改分支
POST   /api/projects/remove?profile=         移除项目
POST   /api/projects/pull?profile=           立即拉取（projectId 可选=全部）

GET    /api/schedule?profile=                读计划
POST   /api/schedule?profile=                写计划

GET    /api/pull-history?profile=&limit=     执行记录
```

- 设置工作空间根目录用新增的 `POST /api/workspace/dir`（body `{ profile, path }`），内部写 `workspaces.default`。不复用 `/api/config`：避免把整个 config 表单语义绑进目录选择，同时保证在线/离线 profile 都能写（与 `applyConfigToDisk` 同样的兜底）。

## 9. 控制台 UI（`web/`）

- 入口：在 `ProfileDetail` 顶部导航 / 或独立视图加入「工作空间」区块（已过目 mockup）。
- 卡片：① 工作空间目录（路径 + `更换目录…`）② Git 账号（列表 + 添加/重新授权/移除）③ 项目（表格：项目/仓库/分支/状态/最后拉取/操作）④ 定时更新（开关/间隔/策略/保存/立即拉取 + 执行记录表）。
- 弹框：
  - `DirectoryPicker`：面包屑 + 子目录列表 + 上一级 + 新建文件夹 + 选择。
  - `AccountDialog`：平台选择 + 服务地址 + 用户名 + PAT + 测试连接。
  - `AddProjectDialog`：`从账号选择` / `手动输入地址` 两个 Tab。
- 复用现有 shadcn 组件（`Button/Card/Dialog/Select/Input/Switch/Tabs`）与 `sonner` toast；不引入新 UI 依赖。
- 状态色：`已最新`=绿、`落后 N`=黄、`有本地改动`=黄、`失败`=红。

## 10. `/config` 卡片与斜杠命令

### 10.1 卡片

- 在 `src/card/config-card.ts` 增加「工作空间与项目」区块：
  - 工作空间目录（只读 + 提示 `/ws dir`）。
  - 项目列表（名称 + 分支 + `[改分支]`）+ `[+ 添加项目]` `[− 移除项目]`。
  - 定时更新：状态 + `[开关] [改间隔] [立即拉取]`。
  - 最近执行记录 + `[查看全部记录]`。
  - `[打开控制台]`。
- 多步表单（添加项目：先填地址 → 再选分支；改间隔：预设选项）复用 `src/card/callback-store.ts` 的回调状态机。

### 10.2 斜杠命令

| 命令 | 作用 |
|---|---|
| `/ws dir <路径>` | 设置工作空间根目录（同时是 `/cd` 的默认） |
| `/ws pull [项目名]` | 立即拉取单个或全部项目 |
| `/ws schedule on\|off\|<分钟>` | 开关或设置定时计划 |
| `/project add <地址> [分支]` | 手动添加项目 |
| `/project rm <名字>` | 移除项目（不删目录） |
| `/project branch <名字> <分支>` | 改项目分支 |

- 命令与卡片按钮共用同一套 `config-ops`/项目操作函数，保证行为一致。
- 权限沿用现有 `/config` 的 owner/admin 限制。

## 11. 安全与密钥

- token 仅存主机级 keystore（AES-256-GCM，0600），列表/日志/卡片均不回显。
- 拉取时 token 通过环境变量 + `GIT_CONFIG_COUNT`/`credential.helper` 注入，**不出现在命令行参数**（避免 `ps` 泄露）。
- 目录浏览仅本机可用；越界路径（工作空间根之外）默认拒绝。
- 移除账号即删密钥；重置 config 不影响 keystore 其它条目。
- 日志脱敏：沿用现有日志，禁止打印 token/repoUrl 中的凭据。

## 12. 错误处理与边界

- 工作空间目录非法（不存在/非目录/过宽）→ 拒绝并提示。
- clone 失败 → 该条记 `failed`，不阻断其它项目。
- 账号测试失败（401/403/网络）→ 拒绝保存或标记为"未验证"。
- `git` 未安装 → 控制台顶部提示，定时任务整轮跳过并记录。
- 非快进 / 冲突 / 脏工作区 → 记 `failed`/`skipped`，绝不强推覆盖。
- 工作空间根变更 → 仅提示，不自动移动/删除既有项目目录。
- profile 离线时失败通知 → 记 `detail:"未通知（profile 离线）"`，在线后可手动查看。
- 记录文件损坏（非法 JSON 行）→ 跳过坏行继续读取。

## 13. 分期交付

1. **P1**：工作空间目录（浏览 + 设置）+ 项目（手动添加 / clone·关联 / 改分支 / 移除）+ 手动拉取 + 状态。控制台页面 + API。
2. **P2**：全局 Git 账号 + 仓库列表 + 「从账号添加」+ token 注入拉取。
3. **P3**：supervisor 定时任务 + 执行记录 + `/config` 卡片与命令 + 失败通知。

每期都保持可独立发布、可独立测试。

## 14. 测试

- **单元**：账号 store（增删改 + 密钥 id 约定）、项目 store 规范化与路径越界、provider URL→请求/响应映射（mock fetch）、scheduler tick 决策（假时钟 + 假 git）、git-ops（mock spawn，覆盖 clone/关联/dirty/ff/pull）、history 截断与坏行容忍。
- **集成**：API 路由（临时 `LARK_CHANNEL_HOME` + 本地 bare 仓库）、目录浏览、批量加项目、立即拉取写记录、`/config` 卡片区块渲染。
- **回归**：现有 config 卡片、`/ws`、`/cd` 测试保持通过。
- 平台：macOS / Ubuntu / Windows（CI 三平台），Windows 重点覆盖盘符与路径分隔符。

## 15. 验收标准

1. 控制台「工作空间」页可弹框浏览本机目录并设置根目录，默认值来自 `--workspace`，可修改。
2. 可添加全局 Git 账号（PAT）并测试连接；token 不回显、只存加密。
3. 可自动拉取账号仓库列表勾选添加，或手动填地址添加；每个项目可选分支。
4. 项目列表显示同步状态，可手动拉取单个/全部。
5. 可配置并启停定时任务（间隔 + 策略）；执行记录可查；脏工作区被跳过并记录。
6. 拉取失败且 profile 在线时给 owner 发飞书消息。
7. `/config` 卡片可查看配置、开关任务、改间隔、加减项目、改分支、看记录、打开控制台。
8. 既有 `/ws`、`/cd`、`/config`、卡片行为不回归。
