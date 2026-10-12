# 移除项目时同步删除本地目录（设计）

> 状态：已与用户确认（2026-10-12）。当前「移除」只删记录、保留磁盘目录；本设计让移除时可一并递归删除工作空间内的项目目录。

## 背景与风险

添加项目时，若工作空间内已存在 origin 相同的仓库，`ensureCheckout` 会以 `attached` 方式**挂载**它（见 `src/git/git-ops.ts`）。因此被移除的项目目录**可能是用户原本就有的仓库**，可能含未提交改动。删除目录属破坏性操作，必须二次确认。

## 决策（用户已确认）

- 交互：**确认后删除**。确认框显示项目名与完整路径；同时提供「仅移除记录、保留目录」的次要选项。
- 有未提交改动 / 目录不存在 / 非 git 仓库时，框内红字警示，但仍允许删除。

## 后端：`POST /api/projects/remove`

`removeProject(profile, rootDir, body)`：

- body 新增 `deleteDir?: boolean`，**默认 `false`**（既有调用/测试仍只删记录，属显式 opt-in）。
- `deleteDir === true` 时：
  1. 用 `resolveProjectDir(workspaceDir, localPath)` 解析目录（该函数已拒绝 `..` 越界）。
  2. **额外拒绝**：解析结果等于工作空间根目录本身时，不删除目录（仅删记录并给出 warning）。
  3. **先删目录、后删记录**：`rm(dir, { recursive: true, force: true })`。删除失败 → 抛出错误且**保留记录**（可重试）；目录不存在 → 视为已删，仅删记录。
- 返回 `ProjectsView` 并附带可选字段：
  ```ts
  removed?: { id: string; dir?: string; deleted: boolean; warning?: string };
  ```
  供前端区分「已删除目录 / 仅移除记录 / 删除被跳过（越界或根目录）」。

## 前端

- `WorkspaceView` 的「移除」改为打开确认框（新组件 `RemoveProjectDialog`）：
  - 展示项目名、`absolutePath`；
  - 红字警示条件：目录不存在 | 非 git 仓库 | `status.dirty`；
  - 主按钮「移除并删除目录」→ `POST { id, deleteDir: true }`（destructive）；
  - 次按钮「仅移除记录」→ `POST { id }`。
- toast：`已移除并删除目录` / `已移除（保留目录）` / 出现 warning 时展示 warning。

## 安全与边界

- 只允许删除**严格位于工作空间内**的目录；拒绝工作空间根、拒绝越界。
- 不使用 shell 拼接；直接用 `fs.rm`。
- 不提供回收站/撤销（超出范围）。

## 测试

- 集成 `removeProject`：
  - `deleteDir:true` → 目录与记录都被删除；
  - `deleteDir` 缺省/false → 目录保留、记录删除；
  - `localPath` 越界（`../escape`）→ 目录不动、记录删除、返回 warning；
  - 目录即工作空间根 → 不删除目录、记录删除、warning；
  - 脏树（有未提交改动）→ 仍删除目录。
- 路由 `workspace-routes.test.ts`：`POST /api/projects/remove { id, deleteDir: true }` → 目录消失、列表为空。
- 前端：`pnpm exec tsc --noEmit -p web/tsconfig.json` + `pnpm build:web`。
