# 控制台「角色」模块 · 二期 2a：MCP / Skill 目录发现与选择（只读，不强制） —— 设计

- 日期：2026-10-13
- 关联：`2026-10-13-web-ui-role-module-design.md`（一期 spec，§9 为二期待办）、`2026-10-12-codegraph-workspace-integration-design.md`（`opencodeConfigDirCandidates` / `parseJsonc`）
- 前置：一期已落地（角色文本软限制，三端注入，`src/ui/role-api.ts` + `GET/POST /api/role` + 前端「角色」页签）。

## 1. 背景与调研结论

二期原计划（一期 spec §9）设想「拉取 MCP / skill 目录 + 白名单强制生效」。对真实代码的可行性调研发现，原设想中的多数机制**当前并不存在**：

| spec §9 设想 | 真实现状 |
| --- | --- |
| opencode 走 HTTP `/config`、`/mcp`、`/skill` | 代码中**无**这些端点调用；`OpencodeServer` 只暴露 `baseUrl`/`authHeader`，无 fetch 封装 |
| opencode v1 复用外部 serve 时降级 | 复用分支存在（`src/agent/opencode/server.ts:113-117`），复用即无法注入 per-profile 配置 |
| opencode v2 注入 `OPENCODE_CONFIG` | **完全未实现**；也无「合并写 opencode 配置」的先例（codegraph 只读 + 交外部二进制写） |
| claude `--mcp-config` + `--strict-mcp-config` | **未使用**；也不读 `~/.claude.json` / `.mcp.json` |
| codex 读 `config.toml` 的 `[mcp_servers]` | **无 TOML 解析器**，也无 TOML 依赖 |
| 各端 skill 目录扫描 | **完全未实现**；`skillsEnabled` 字段只是存着 |
| 测试用假 opencode HTTP server | **不存在**（v1 靠模块 mock，v2 靠注入 `sdkFactory`） |

因此二期拆成两段：**2a（本设计）= 目录发现 + 只读展示 + 勾选存储，不强制生效**；**2b = 分端白名单强制生效**（claude 临时 `--mcp-config`、opencode v1 `tools` map、opencode v2 `OPENCODE_CONFIG` 注入等，另开 spec）。2a 的风险最低、可独立验收，并为 2b 铺设目录与选择契约。

## 2. 目标

1. 「角色」页新增「MCP / Skill 范围」区：列出该 profile 当前环境的 MCP server 与 skill。
2. 允许勾选「对本 profile 生效」的集合，并**落盘保存**（复用 `RoleConfig.mcpEnabled` / `skillsEnabled`），页面重进可回显。
3. 明确标注：**当前仅保存选择，尚未强制生效（2b 落地）**，不做「假开关」。
4. 纯文件源、零新依赖、探测失败不报 500。

## 3. 非目标（YAGNI）

- 不做任何**强制生效**：不注入 `--mcp-config`、不传 opencode `tools` map、不注入 `OPENCODE_CONFIG`。
- 不做 **HTTP 探测**（`/config`、`/mcp`、`/skill`、`/api/skill`）。
- 不新增 npm 依赖（含 TOML 库）。
- 不接管/改写用户 agent 配置目录本体。
- 不改一期已定的角色注入路径与 `/api/role` 的 `prompt` 语义。

## 4. 已决设计选择

1. **分期**：2a 只做发现/展示/存储；2b 才做强制。
2. **数据源**：三端纯文件源（opencode 配置、claude `~/.claude.json` + 工作区 `.mcp.json`、codex `config.toml`）。
3. **codex TOML**：在 `role-catalog.ts` 内手写只读极简子集解析（不引入依赖）。
4. **skill 覆盖**：2a 只发现 claude（`~/.claude/skills`、`<workspace>/.claude/skills`）；opencode / codex 的 skill 返回 `available:false`（诚实标注「2b 支持」），不臆造目录。
5. **2a 落盘勾选**：`mcpEnabled` / `skillsEnabled` 在 2a 即写入并回显，语义先定型，2b 直接消费。

## 5. 架构

### 5.1 新增 `src/agent/role-catalog.ts`

单一职责：给定 profile 状态，产出目录视图（发现 + 能力分级），不做任何注入。

```ts
export type RoleScopeCapability = 'control' | 'readonly' | 'none';

export interface RoleCatalogCapabilities {
  mcp: RoleScopeCapability;
  skills: RoleScopeCapability;
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  /** 人类可读来源，如 `~/.claude.json`、`<workspace>/.mcp.json`、`opencode.json`、`config.toml`。 */
  source: string;
}

export interface SkillEntry {
  name: string;
  source: string;
}

export interface CatalogSection<T> {
  /** 是否成功探测到该来源（false = 无法读取/解析，items 为空）。 */
  available: boolean;
  /** available=false 时的简要原因（用于 UI 提示）。 */
  error?: string;
  items: T[];
}

export interface RoleCatalogView {
  profile: string;
  agentKind: AgentKind;
  capabilities: RoleCatalogCapabilities;
  mcp: CatalogSection<McpServerEntry>;
  skills: CatalogSection<SkillEntry>;
}
```

- 能力分级（一期已由 `src/ui/role-api.ts` 的 `ROLE_SCOPE` 表达，本设计将其**迁移**到本模块统一维护）：

  | agent | mcp | skills |
  | --- | --- | --- |
  | claude | control | readonly |
  | codex | readonly | none |
  | opencode | control | control |

  > 迁移 `RoleScopeCapability` / `ROLE_SCOPE` / `capabilityFor` 到本模块；`role-api.ts` 改为从本模块导入。这让「能力分级」与「目录」定义同处一处，也消除一期评审记录的一处重复。

- 入口：

  ```ts
  export interface RoleCatalogOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
  }
  export async function buildRoleCatalog(
    state: MutableProfileState,
    opts: RoleCatalogOptions = {},
  ): Promise<RoleCatalogView>;
  ```

  路径解析（均从 `state` 推导，不依赖 `deps`）：
  - workspace 目录 = `state.profileConfig.workspaces.default ?? profileAppPaths(state).defaultWorkspaceDir`
  - codexHome = `state.profileConfig.codex?.codexHome ?? join(profileAppPaths(state).profileDir, 'codex-home')`
  - opencode 配置目录 = `opencodeConfigDirCandidates(opts.env, opts.platform, opts.home)`

### 5.2 各端发现细则

- **opencode（mcp: control，skills: control）**
  - MCP：在 `opencodeConfigDirCandidates()` 内依次尝试 `opencode.jsonc`、`opencode.json`，用 `parseJsonc` 解析；server 来源：
    - server 名集合：若 `config.mcp.servers` 是对象则取其键（旧格式）；否则取 `config.mcp` 自身除 `servers` 外的对象键（新格式）；
    - 每项 `type === 'local'` → `stdio`；`type === 'remote'` → 有 `url` 含 `sse` 时 `sse`，否则 `http`；未知 → `unknown`。
  - skill：2a 返回 `{ available: false, error: '2b 支持' }`。
- **claude（mcp: control，skills: readonly）**
  - MCP：`~/.claude.json`（`opts.home`）的顶层 `mcpServers` 对象键；再合并 `<workspace>/.mcp.json` 的 `mcpServers` 键。两者**各自**独立成 section 来源，合并到一个 `mcp.items`（按 name 去重）。任一无文件不视为错误；全部读不到才 `available:false`。
  - skill：扫 `~/.claude/skills/*`、`<workspace>/.claude/skills/*`（仅取目录名）；两者皆不存在则 `{ available: true, items: [] }`（「没有 skill」是有效结果，不是失败）。
- **codex（mcp: readonly，skills: none）**
  - MCP：读 `<codexHome>/config.toml`，用手写只读极简解析提取 `[mcp_servers.<name>]` 表头的 `<name>`；有 `url = ...` → `http`，有 `command = ...` → `stdio`，否则 `unknown`。文件不存在 → `available:false`。
  - skill：`{ available: false, error: '该桥接无 skill' }`。

### 5.3 只读极简 TOML 解析（codex）

`role-catalog.ts` 内私有函数，仅覆盖目录展示所需子集，明确不支持完整 TOML：

```ts
/** 仅提取 `[mcp_servers.<name>]` 的表名；忽略注释/字符串内的 `[`。 */
function parseMcpServerNames(toml: string): string[];
```

- 逐行：去掉 `#` 注释（字符串外的）；匹配 `^\s*\[\s*mcp_servers\.([A-Za-z0-9_.-]+)\s*\]\s*$`；同名去重。
- 识别 transport：在对应 section 内找 `url\s*=`（`http`）或 `command\s*=`（`stdio`）。
- 明确不支持：带引号的键（`["my server"]`）、内联表、多行字符串；这些在 2a 归为「未识别」（跳过该 server），不报错。
- 文件读取/整体异常 → 返回空并令 section `available:false`。

### 5.4 `src/ui/role-api.ts` 扩展

- `RoleView` 增加当前选择回显：
  ```ts
  /** 当前存储的 MCP 白名单；缺失 = 未限制。 */
  mcpEnabled?: string[];
  /** 当前存储的 skill 白名单；缺失 = 未限制。 */
  skillsEnabled?: string[];
  ```
- `buildRoleView` 填充上述字段（有则带，无则省略）。
- `saveRoleConfig` 的 `parseRoleBody` 扩展：`prompt` 仍必须 string；`mcpEnabled` / `skillsEnabled` 采用**三态**：

  | body 取值 | 语义 |
  | --- | --- |
  | 省略（`undefined`） | 保持既有选择不变 |
  | `null` | 清除该白名单 = 不限制 |
  | `[]` | 显式全部禁用 |
  | `string[]` | 显式允许集合（保存时 trim、去空、去重） |
  | 其它（数字/对象/含非字符串项） | 400 |

  合并后交由 `normalizeRole`（`src/config/profile-schema.ts`）统一归一化：非空 prompt 更新 prompt，空 prompt 清 prompt，白名单按上面三态独立保留/更新/清除；三者皆无则删除整个 `role`。

  > 之所以需要 `null` 这一态：若「不限制」只由**省略**表达，用户把已有显式白名单改回「全选/不限制」时，省略会被后端理解为「保持原值」，无法表达清除。三态消除了这个歧义。

### 5.5 路由（`src/ui/server.ts`）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/role/catalog?profile=` | 200 `RoleCatalogView`（`resolveTargetState` 判 live；探测失败一律 200 + `available:false`） |

插在现有 `/api/role` 块之后、`/api/chats` 之前。

## 6. 前端

- `web/src/lib/types.ts`：新增 `RoleScopeCapability`（若已有则复用）、`McpTransport`、`McpServerEntry`、`SkillEntry`、`CatalogSection<T>`、`RoleCatalogView`；`RoleView` 增加 `mcpEnabled?` / `skillsEnabled?`。
- `web/src/views/RoleView.tsx`：在「角色设定」卡之后新增「MCP / Skill 范围」卡：
  - 挂载时并行 `GET /api/role`（角色 + 当前选择）与 `GET /api/role/catalog`（目录）。
  - 顶部显著说明：**「当前仅保存选择，尚未强制生效（2b 落地）」**。
  - MCP 段：逐项 `Switch`（复用 `web/src/components/ui/switch.tsx`）。`capabilities.mcp === 'readonly'` → 展示但禁用；`'none'` → 不渲染该段。`mcp.available === false` → 显示错误 + 「重试」。
  - Skill 段同理，按 `capabilities.skills` 处理。
  - 选择语义（真实状态为「显式勾选集」`chosen`）：
    - `chosen.size === 全部可选数` → 发送 `null`（不限制）；
    - `chosen.size === 0` → 发送 `[]`（全部禁用）；
    - 其它 → 发送勾选数组。
    - 目录 `available === false` 或能力非 `control` → **不发送**该字段（保持后端既有值）。
  - 保存沿用 `POST /api/role`，body = `{ prompt, ...(mcpEnabled !== undefined ? { mcpEnabled } : {}), ...(skillsEnabled !== undefined ? { skillsEnabled } : {}) }`（`null` 表示清除）。

## 7. 错误处理

| 场景 | 结果 |
| --- | --- |
| 任一目录来源读/解析失败 | 该 section `available:false` + `error`，HTTP 仍 200 |
| profile 不存在 | `resolveTargetState` → 404 |
| 无任何 MCP / skill | `available:true, items:[]`（合法结果） |
| `mcpEnabled` / `skillsEnabled` 既非 `string[]` 也非 `null`（缺省除外） | 400「mcpEnabled must be a string array」 |
| 磁盘写失败 | 500「保存失败：…」，in-memory 不更新（沿用一期） |

## 8. 测试计划

- 单元 `tests/unit/agent/role-catalog.test.ts`：
  - opencode：临时 `OPENCODE_CONFIG_DIR` 写 `opencode.jsonc`（含 `mcp` 与旧 `mcp.servers`），断言 server 名与 transport、`available:true`；文件缺失 → `available:false`。
  - claude：临时 home 写 `~/.claude.json` + 临时 workspace 写 `.mcp.json`，断言合并去重；workspace 无 skill 时 `skills.available:true, items:[]`；有 `~/.claude/skills/*` 目录时列出。
  - codex：临时 `codexHome` 写 `config.toml`（含 `[mcp_servers.x]`、注释、字符串），断言名称与 transport；无文件 → `available:false`。
  - 能力分级矩阵断言。
- 单元 `tests/unit/ui/role-api.test.ts`：扩展 `saveRoleConfig` 对 `mcpEnabled`/`skillsEnabled` 的解析、400 校验、落盘 + 原地刷新、`buildRoleView` 回显；保持既有白名单保留用例。
- 集成 `tests/integration/ui/server.test.ts`：`GET /api/role/catalog` 200 形状；构造一个探测失败场景断言 200 + `available:false`。
- 前端无单测：`tsc -p web/tsconfig.json` + `pnpm build:web`。

## 9. 验收标准

1. 「角色」页出现「MCP / Skill 范围」区，列出该 profile 探测到的 MCP / skill，明确标注「仅保存、未强制」。
2. 勾选后可保存、重进回显；探测失败显示「拉取失败，可重试」，不报 500。
3. 三端各自按能力分级展示（claude 可勾 MCP、skill 只读；codex MCP 只读、无 skill 段；opencode 均可勾）。
4. 零新依赖；`pnpm typecheck`、`pnpm build`、相关 `vitest` 套件通过。
5. 对用户既有 agent 配置目录无写入。
