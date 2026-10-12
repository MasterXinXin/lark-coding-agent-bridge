# P3：定时拉取 + 执行记录 + 卡片与命令（计划）

- 日期：2026-10-12
- 状态：已批准的总设计 `2026-10-10-workspace-git-projects-design.md` §7/§10/§13 的实施计划
- 分支：`feat/p3-scheduler`
- 目标：在既有 P1/P2/P2.5 基础上补齐 P3 —— supervisor 级定时拉取、执行记录查询、`/config` 卡片区块、斜杠命令、失败通知。

## 现状

- 已有：`workspace/projects.ts`（项目 + `schedule` 数据）、`workspace/history.ts`（`appendPullRecord`/`readPullRecords`）、`ui/workspace-api.ts`（`pullProjects`/`getSchedule`/`setSchedule`）、`ui/server.ts`（`/api/schedule` 已有，`/api/projects/pull` 走后台任务）。
- 缺失：`workspace/scheduler.ts`（定时器）、`GET /api/pull-history`、失败通知、`/config` 卡片区块、`/ws dir|pull|schedule` 与 `/project *` 命令、supervisor 装配。

## 任务拆分

### P3.1 调度器 + 执行记录 API（后端核心）

- 新增 `src/workspace/scheduler.ts`：`PullScheduler` 单例类。
  - 依赖全部可注入以便测试：`now()`、`listProfiles()`、`runProfile(profile)`、`notify(profile, message)`、`checkGit()`、`seedLastRun(profile)`、`intervalMs`、`rootDir`。
  - `start()`：`setInterval`（默认 60s，`unref()` 不阻止进程退出）；`stop()`：清定时器。
  - `tick()`（可单独测试）：
    1. `running` 标志防重入。
    2. `checkGit()` 为假 → 跳过整轮并记日志。
    3. 遍历 `listProfiles()`，逐个读 `projects.json` 的 `schedule`；未启用跳过。
    4. 到点判断：`lastRun` 表，`now - lastRun >= intervalMinutes*60000`；首次见到某 profile 时先 `seedLastRun` 从 `pull-history.jsonl` 里最后一条 `trigger:'schedule'` 记录恢复 `lastRun`（无记录或读取失败则视为到点），恢复后再判断；执行前先 `lastRun=now`，避免慢拉取重入。
    5. 调 `runProfile(profile)` 执行该 profile 的全部项目拉取，`trigger:'schedule'`。
    6. 若有 `failed` 且 `notifyOnFailure` → `notify(profile, 摘要)`；profile 离线（notify 返回 false）只记日志。
    7. 单 profile 异常不阻断其它 profile。
- `ui/workspace-api.ts`：`pullProjects` 增加可选 `trigger: PullTrigger = 'manual'` 参数并写入记录；新增 `readPullHistory(profile, rootDir, limit)`。
- `ui/server.ts`：新增 `GET /api/pull-history?profile=&limit=`（limit 夹取 1–500，默认 50）。
- 装配 `cli/commands/start.ts` 的 `runSupervisorConsole`：创建并 `start()` `PullScheduler`；`notify` 用 `supervisor.channelFor(profile)` + `controlsFor(profile)?.botOwnerId`，离线返回 false；关机时 `stop()`。
- 测试：`tests/unit/workspace/scheduler.test.ts`（假时钟/假 git/假 notify：未启用不发、到点才发、防重入、失败通知、离线不通知、git 缺失跳过）；`tests/integration/ui/*`（`/api/pull-history`、`pullProjects` 的 trigger）。

**验收**：启用计划后按间隔自动拉取并写入 `trigger:'schedule'` 记录；失败且在线时给 owner 发消息；不可用时跳过不发。

### P3.2 斜杠命令

- `src/commands/index.ts`：
  - `/ws dir <路径>`：设置 profile 工作空间根（`workspaces.default`），复用 `saveWorkspaceConfig`。
  - `/ws pull [项目名]`：立即拉取单个/全部，`trigger:'manual'`。
  - `/ws schedule on|off|<分钟>`：开关或设间隔。
  - `/project add <地址> [分支]`：手动添加。
  - `/project rm <名字>`：移除清单记录（不删目录）。
  - `/project branch <名字> <分支>`：改分支。
- 新 handler `/project` 注册进 `handlers` 与 `ADMIN_COMMANDS`。
- 与卡片/控制台共用 `workspace-api` 的函数，行为一致。
- 测试：`tests/unit/commands/*` 或集成。

**验收**：聊天里能用上述命令完成与控制台等价的操作。

### P3.3 `/config` 卡片：红色提示引导

- 用户决定：**不在 `/config` 卡片里做工作空间/Git 的可编辑配置**，改为在卡片里加一条醒目红色提示，引导去浏览器控制台配置，并附上控制台链接。
- `src/card/config-card.ts`：`configFormCard` 顶部新增红色 `markdown` 元素（`<font color='red'>`）：说明「工作空间根目录、Git 账号与项目 / 定时拉取请在浏览器控制台配置」；有 `consoleUrl` 时附 `👉 打开 Web 控制台：[url]`，无控制台时提示以 `--web-ui` 启动。
- 测试：`tests/unit/card/config-card.test.ts` 断言有/无 `consoleUrl` 两种情况都含红色提示，且无控制台时不出现 `Web 控制台` 字样。

**验收**：`/config` 卡片顶部有醒目红色提示与（可用时）控制台链接。

### P3.4 文档与总验收

- 更新 `README.md` / `README.zh.md` 的「控制台：工作空间与项目」小节，补定时任务/命令/卡片。
- 跑全量测试与构建，核对验收标准 §15 的 P3 项。

## 非目标（沿用总设计）

- 不做每仓库独立计划；不做 push/合并/冲突解决；卡片不做本地目录浏览（退化为文字路径）；不改动 `@larksuite/channel` 管线。

## 交付顺序

P3.1 → P3.2 → P3.3 → P3.4，逐个提交、独立评审；每个任务保持测试通过。
