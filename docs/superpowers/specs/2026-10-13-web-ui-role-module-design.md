# 控制台「角色」模块（系统提示词软限制 + MCP/Skill 范围） —— 设计

- 日期：2026-10-13
- 关联：`2026-10-12-console-schedule-ui-design.md`（控制台页签结构）、`2026-10-12-codegraph-workspace-integration-design.md`（CodeGraph MCP 写入 opencode 配置）
- 起因：控制台 profile 详情页目前有「配置」「工作空间」两个页签。用户希望在「工作空间」旁边新增第三个模块「角色」——本质是**该 profile 的系统提示词设定**；对 `opencode`（以及 `claude`/`codex`）的每轮运行做**软限制**（prompt 层约束，非硬性权限）。若可行，还能拉取当前环境里所有 MCP server 与 skill 列表，并**勾选哪些对本 profile 生效**。

## 1. 目标

1. profile 详情页新增「角色」页签（位于「工作空间」旁边），每 profile 一份**内联角色文本**，全局生效（所有会话同一份）。
2. 角色文本作为**软限制**注入该 profile 每次 agent 运行的 system prompt 通道：
   - `claude`：追加系统提示文件（`--append-system-prompt-file`）
   - `codex`：前缀进 stdin
   - `opencode`：v1 用每次 prompt 的顶层 `system`；v2 前置进文本
3. **在线 profile 改完即时生效**（每轮运行实时读取 profileConfig），离线 profile 落盘后下次启动生效——与现有 `meeting`/`model` 行为一致。
4. （二期）拉取当前环境的 MCP server 与 skill 列表，勾选白名单"对本 profile 生效"；按各桥接原生能力分级，做不到的只读展示并在 UI 标注。

## 2. 非目标

- 不做**可复用角色库**（多角色集中管理、profile 引用）——本期是每 profile 一份内联文本（已确认）。
- 不做**per-chat / per-user 角色覆盖**——本期 profile 全局（已确认）。
- 不做**硬性权限控制**。角色是 prompt 层软约束；MCP/Skill 白名单尽量用各 agent 原生开关实现，拿不到就降级只读。
- 不改动作业/回滚基座；不改动 `access` / `meeting` / `permissions` 既有语义。
- 不接管用户既有 agent 配置目录（不重写 `opencode.json` / `~/.claude.json` / `~/.codex/config.toml` 本体）。

## 3. 可行性结论与现状

**结论：核心「角色」（软限制）三端均可行；MCP/Skill 白名单部分可行，需按桥接降级。**

关键代码位置：

| 事实 | 位置 |
| --- | --- |
| 详情页两个页签（配置 / 工作空间） | `web/src/views/ProfileDetail.tsx` `Tabs` |
| 运行期系统提示注入模式声明 | `src/agent/capability.ts` `AgentCapability.promptInjection` |
| claude 追加系统提示文件 | `src/agent/claude/adapter.ts:71` |
| codex 系统提示前缀进 stdin | `src/agent/codex/adapter.ts:156`（`prefixBridgeSystemPrompt`） |
| opencode v1 每轮 `system` 字段 | `src/agent/opencode/session-consumer.ts:297` |
| opencode v2 无 `system`，拼进文本 | `src/agent/opencode/transport-v2.ts:55` `buildV2PromptText` |
| 每轮运行参数装配（可读 profileConfig） | `src/policy/run-policy.ts` `evaluateRunPolicy` |
| 运行参数透传给 adapter | `src/runtime/run-executor.ts` `runOptions` |
| profile 配置模型 + normalize | `src/config/profile-schema.ts` `ProfileConfig` / `normalizeProfileConfig` |
| 配置落盘/在线刷新 | `src/config/config-ops.ts`（`savePreferencesConfig` 为范本） |
| 控制台路由 | `src/ui/server.ts` `route()` |
| opencode 配置读取工具（可复用） | `src/workspace/codegraph.ts` `opencodeConfigDirCandidates` / `parseJsonc` / `stripJsonComments` |

三端能力对照：

| 能力 | claude | codex | opencode |
| --- | --- | --- | --- |
| 角色注入（软） | ✅ 追加系统提示文件 | ✅ 前缀进 stdin | ✅ v1 `system`；v2 前置文本 |
| MCP 列表 | ✅ 读 `~/.claude.json` + `.mcp.json` | ✅ 读 `~/.codex/config.toml` | ✅ HTTP `/config`+`/mcp`，或读 `opencode.json(c)` |
| Skill 列表 | ✅ 扫 `~/.claude/skills` 等 | ❌ 无 skill 概念 | ✅ HTTP `/skill`（新版本）或扫标准目录 |
| 按次运行限制范围 | 中（`--mcp-config`+`--strict-mcp-config`） | 弱（仅整体 `--ignore-user-config`） | v1 每轮 `tools` map；MCP 用 config `enabled`；v2 需注入 agent 配置 |

## 4. 行为定义

- **角色**：profile 的一份系统提示词文本，作为 `## 角色设定` 段落追加到 bridge 既有系统提示之后。
- **生效面**：该 profile 的所有运行（私聊 / 群 / 话题 / 文档评论 / 会议）。
- **生效时机**：在线 profile 下一轮运行即生效；离线 profile 落盘后下次启动生效。
- **白名单**：MCP/Skill 勾选项 = 允许集合；未勾选项在该 profile 运行中禁用。
  - 字段**缺失** = 跟随 agent 原生配置，不做干预。
  - 显式**空数组** = 全部禁用（与"未配置"区分）。
  - 勾选全部 = 等价于不限制（实现上可写回完整列表或删除字段，二选一由实现定，建议删除以保持配置干净）。

## 5. 配置模型（一期）

`src/config/profile-schema.ts` 新增顶层字段（照 `meeting` 先例）：

```ts
export interface RoleConfig {
  /** 角色系统提示词（软限制）。trim 后为空 = 不注入。 */
  prompt: string;
  /** 二期：对本 profile 生效的 MCP server 白名单。缺失 = 跟随原配置。 */
  mcpEnabled?: string[];
  /** 二期：对本 profile 生效的 skill 白名单。缺失 = 跟随原配置。 */
  skillsEnabled?: string[];
}

// ProfileConfig 增加： role?: RoleConfig;
```

- 新增 `normalizeRole(input): RoleConfig | undefined`：trim `prompt`；白名单仅保留 `string[]`（去重、去空）。若 `prompt` 为空且两条白名单都缺失 → 返回 `undefined`，**不落 `role` 字段**（保持配置干净）。
- `normalizeProfileConfig` 的返回对象显式加入 `...(role ? { role } : {})`（当前实现会丢弃未知字段，必须显式加，否则写入无效）。
- `CreateDefaultProfileConfigInput` 不加 role（默认不生成）。

## 6. 运行时注入（一期核心）

1. `src/agent/bridge-system-prompt.ts` 新增组合函数：

   ```ts
   /** bridge 运行约定 + 可选「## 角色设定」段，供三端统一调用。 */
   export function composeSystemPrompt(
     identity: AgentBotIdentity | undefined,
     rolePrompt?: string,
   ): string;
   ```

   实现：`buildBridgeSystemPrompt(identity)` 之后，若 `rolePrompt?.trim()` 非空，追加 `\n## 角色设定\n\n${role}\n`。
   `prefixBridgeSystemPrompt(prompt, identity, rolePrompt?)` 增加可选第三参，在 `## user_message` 之前插入角色段。

2. `src/agent/types.ts` `AgentRunOptions` 增加可选 `rolePrompt?: string`。

3. `src/policy/run-policy.ts` `RunPolicyAllow` 增加 `rolePrompt?: string`；`evaluateRunPolicy` 从 `input.profileConfig.role?.prompt` 取（trim 非空才带）。

4. `src/runtime/run-executor.ts` `runOptions` 增加 `rolePrompt: input.policy.rolePrompt`。

5. 三端 adapter 改用 `composeSystemPrompt(this.botIdentity, opts.rolePrompt)`：
   - `src/agent/claude/adapter.ts`：写入系统提示文件的内容。
   - `src/agent/codex/adapter.ts`：`prefixBridgeSystemPrompt(opts.prompt, this.botIdentity, opts.rolePrompt)`。
   - `src/agent/opencode/session-consumer.ts`：`system: composeSystemPrompt(this.deps.botIdentity, opts.rolePrompt)`（v1）；`transport-v2.ts` 的 `buildV2PromptText` 用 `o.system`，无需额外改动。

> 因 `evaluateRunPolicy` 每次运行都读当前 `profileConfig`，在线 profile 保存后**下一轮运行**即生效；`Controls.profileConfig` 在保存时原地重建（见 §7）。

## 7. 后端 UI / API

### 7.1 视图与保存（新增 `src/ui/role-api.ts`）

```ts
export interface RoleView {
  profile: string;
  agentKind: AgentKind;
  prompt: string;
  /** 该 agent 的角色注入方式（来自 capability，用于 UI 说明）。 */
  injection: PromptInjectionMode;
  /** 二期：MCP / Skill 控制能力分级。 */
  capabilities: { mcp: 'control' | 'readonly' | 'none'; skills: 'control' | 'readonly' | 'none' };
  live: boolean;
  /** 二期：目录 + 白名单，见 §9。 */
  mcp?: McpCatalogView;
  skills?: SkillCatalogView;
}

/** 读角色视图（在线取 Controls，离线取磁盘 state）。 */
export function buildRoleView(state: MutableProfileState, live: boolean): RoleView;

/** 保存角色（在线 Controls 与离线 state 结构上同形，落盘 + 原地刷新）。 */
export async function saveRoleConfig(
  state: MutableProfileState,
  body: unknown,
): Promise<RoleView>;
```

`saveRoleConfig` 参照 `savePreferencesConfig`：在 `withConfigFileLock(state.configPath, …)` 内读 root、写 `root.profiles[profile].role`、`saveRootConfig`，然后 `state.profileConfig = root.profiles[profile]`、`state.cfg = runtimeProfileConfig(root, profile)`（`Controls` 满足 `MutableProfileState`，故在线即刷新生效）。解析 body：`prompt` 取 string 并 trim；白名单仅在提供时解析（二期）。

### 7.2 路由（`src/ui/server.ts`）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/role?profile=` | 200 `RoleView`（`resolveTargetState` 判定 live） |
| `POST` | `/api/role?profile=` | 200 `RoleView`（保存 `prompt`，二期含白名单） |
| `GET` | `/api/role/catalog?profile=` | 200 `{ mcp, skills }`（二期；探测失败返回分级为 `none`/`readonly` 的空目录，不报错） |

## 8. 前端设计

- 新增 `web/src/views/RoleView.tsx`；`ProfileDetail.tsx` 的 `TabsList` 增加 `<TabsTrigger value="role">角色</TabsTrigger>`，`TabsContent value="role"` 渲染 `<RoleView profile={profile} />`（放在「工作空间」之后）。
- `web/src/lib/types.ts` 增加 `RoleView` / `McpCatalogView` / `SkillCatalogView`。
- 页面结构：
  - **角色设定**卡：`Textarea`（需新增 `web/src/components/ui/textarea.tsx`，样式对齐 `input.tsx`）+ 保存按钮；说明文案点明这是"软限制/提示词，不是硬权限"；在线显示"保存后下一轮运行生效"，离线显示"下次启动生效"。
  - （二期）**MCP / Skill 范围**卡：拉取目录，`Switch`/复选框勾选；`capabilities` 为 `readonly` 时禁用勾选并显示"该桥接仅支持查看"；为 `none` 时不渲染该卡。

## 9. MCP / Skill 目录与白名单（二期，按 agent 降级）

新增 `src/agent/role-catalog.ts`，按 `agentKind` 产出目录并给出控制分级：

- **opencode**（`capabilities.mcp='control'`，`skills='control'`，受版本影响需探测+回退）
  - 目录：优先 HTTP —— v1 `GET /config`（含 `mcp`）、`GET /mcp`（状态）、`GET /skill`；v2 `GET /api/config`、`GET /api/skill`；复用 `OpencodeServer.baseUrl` / `authHeader`。HTTP 不可用或字段缺失时回退读 `opencodeConfigDirCandidates()` 下的 `opencode.json(c)`（复用 `parseJsonc`）。
  - 白名单落地：
    - v1：每轮 `tools` map 关闭未勾选 MCP 工具（`PromptOptions.tools` 已支持）；MCP server 级用注入配置的 `enabled=false`。
    - v2：v2 服务由 bridge 独占 spawn（`OpencodeServer` 选空闲端口 + 生成密码），通过 `OPENCODE_CONFIG` 指向 bridge 生成的 per-profile 配置（合并式，不覆盖用户 provider/model），在其中写 `mcp.<name>.enabled` 与一个携带 `tools`/`permission` 的 agent，并以该 agent 派发。
    - skill：新版 opencode 有 `skills` 发现源；若无法按单个 skill 停用，则退化为"仅能整体启用/关闭 skill 工具"，并在 UI 标注。
- **claude**（`mcp='control'`，`skills='readonly'`）
  - 目录：读 `~/.claude.json` 与项目 `.mcp.json`；skill 扫 `~/.claude/skills`、`.claude/skills`。
  - 白名单：写一份临时 MCP 配置（仅含勾选项）并以 `--mcp-config <file>` + `--strict-mcp-config` 运行。skill 无 per-skill 开关，只读展示。
- **codex**（`mcp='readonly'`，`skills='none'`）
  - 目录：读 profile 的 `codexHome`（或 `~/.codex`）下 `config.toml` 的 `[mcp_servers]`。无 per-run 白名单，只读展示；`skills` 卡不渲染。

> 版本风险：opencode 的 `/config`、`/mcp`、`/skill`、`/mode` 端点在不同版本存在差异，且 v1 路径**可能复用外部已有的 `opencode serve`**（`src/agent/opencode/server.ts` reuse 分支）——此时无法注入 per-profile 配置，仅每轮 `system`（角色）可用；白名单在复用场景下降级为只读。

## 10. 错误处理

| 场景 | 结果 |
| --- | --- |
| `prompt` 非字符串 / 超长 | 400 / 落盘前按上限截断（建议 64KB 上限并提示） |
| profile 不存在 | `resolveTargetState` → 404 |
| 磁盘写失败 | 500「保存失败：…」，in-memory 不更新 |
| 目录探测失败（二期） | 返回空目录 + 分级，不报 500；UI 显示「拉取失败，可重试」 |
| opencode v1 复用外部 serve（二期） | 白名单降级只读；角色仍生效 |

## 11. 测试计划

- 单元
  - `profile-schema`：`normalizeRole`（trim、空则不落字段、白名单清洗）、`normalizeProfileConfig` 保留 `role`。
  - `bridge-system-prompt`：`composeSystemPrompt` 有/无 identity、有/无角色的拼接。
  - `run-policy`：`rolePrompt` 从 profileConfig 透传、空角色不带。
  - `role-api`：`saveRoleConfig` 落盘 + 原地刷新 `state.profileConfig/cfg`。
  - `role-catalog`（二期）：文件回退解析 opencode.json / `.mcp.json` / codex `config.toml`。
- 集成
  - `tests/integration/ui/role-routes.test.ts`（新建）：`GET /api/role` 200；`POST` 保存后 `GET` 回读；在线/离线 live 标记。
  - 运行注入：复用 fake-agent，断言 `runOptions.rolePrompt` 到达 adapter（或在 claude/codex 的命令/标准输入里含角色段）。
- 前端无单测设施：`tsc -p web/tsconfig.json` + `pnpm build:web`。

## 12. 验收标准

1. 详情页出现「角色」页签，可编辑并保存该 profile 的角色提示词。
2. 在线 profile 保存后，下一轮运行的 system prompt 含角色段；离线 profile 下次启动生效。
3. 三端（claude/codex/opencode v1/v2）都能注入角色。
4. （二期）「角色」页能列出当前 MCP/Skill，可勾选生效范围；不支持的桥接明确标注只读/不支持。
5. 不引入新依赖（如需 `Textarea` 则本地手写）；`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。

## 13. 已决设计选择

1. **角色形态**：每 profile 一份内联文本（非可复用角色库）。
2. **生效范围**：profile 全局（不支持 per-chat 覆盖）。
3. **MCP/Skill「范围」语义**：白名单开关（勾选对本 profile 生效）。
4. **实现路线**：运行时注入 + 按 agent 能力降级（不接管用户 agent 配置目录本体）。
5. **分期**：一期 = 角色（三端）；二期 = MCP/Skill 目录与白名单（opencode 全、claude MCP、codex 只读）。

## 14. 风险

1. opencode 端点跨版本差异 → 必须"HTTP 探测 + 文件回退"，并容忍探测失败。
2. opencode v2 无 per-prompt `system`/`tools` → 角色走文本前置、白名单走注入 agent 配置（依赖 v2 独占 spawn）。
3. claude skill / codex MCP 无法真禁用 → UI 诚实标注只读，不做假开关。
4. `evaluateRunPolicy` 新增字段属于策略契约变更 → 需同步检查其调用点与现有测试。
