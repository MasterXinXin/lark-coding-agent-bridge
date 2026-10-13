# 控制台「角色」模块 · 二期 2b：分端白名单强制生效 —— 设计

- 日期：2026-10-13
- 关联：`2026-10-13-web-ui-role-module-design.md`（一期 spec）、`2026-10-13-web-ui-role-module-phase2a-design.md`（2a 设计）
- 前置：一期（角色文本软限制，三端注入）与 2a（MCP / Skill 目录发现 + 只读展示 + 勾选落盘，不强制）均已落地并推送。
- 调研依据：opencode v2 官方文档（<https://opencode.ai/v2/docs/>）＋ **本机 `opencode v2.0.18` 实证** ＋ `@opencode/client@2.0.26` SDK 类型。

## 1. 背景

2a 已把「该 profile 能看到的 MCP server / skill」发现出来并让用户勾选落盘（`RoleConfig.mcpEnabled` / `skillsEnabled`），但**不生效**。2b 的任务：把这些白名单**按各端真实能力强制生效**，并明确哪些端只能只读（不诈称开关）。

2b 的机制在原 2a 设想里写的是「claude 临时 `--mcp-config`、opencode v1 `tools` map、opencode v2 `OPENCODE_CONFIG` 注入」，但当时标注为「完全未实现」。本次调研对每条都做了文档 + 实证核实，结论有五处需要修正（见 §2）。

## 2. 调研结论（opencode v2 为重点）

### 2.1 已核实事实

| 命题 | 结论 | 依据 |
| --- | --- | --- |
| v2 有 `agents.<id>.system` 可设系统提示词 | ✅ 存在，但 **非空值会替换 provider 的 base prompt**（项目 instructions / skills / references 仍追加） | 官方 agents 文档 “System” 节 |
| v2 请求体有 per-prompt `system` 字段 | ❌ 没有。`POST /api/session/{id}/prompt` body 只有 `text/files/agents/skills/metadata/delivery/resume` | OpenAPI `/api/session/{sessionID}/prompt` |
| `agents` 附件可内联 system | ❌ `Prompt.AgentAttachment` 只有 `{ name, mention? }`，**按名字引用**已配置 agent | OpenAPI schema |
| v2 配置里 MCP 的形状 | **`mcp.servers.<name>`**（`type: local/remote`、`disabled`）；v2 **不再**把 server 名直接挂在 `mcp` 下 | 官方 mcp-servers 文档 “Config” |
| v1 配置里 MCP 的形状 | `mcp.<name>`（`enabled` 布尔）—— **2a 代码注释把两者标反了**（见 §2.4） | v1 文档 / migrate-v1 |
| v2 MCP 工具名 / 权限动作 | 工具名 = `<server>_<tool>`（非字母数字归一为 `_`）；权限动作就是 `<server>_<tool>`，`effect: deny` 可**隐藏工具但不断开 server** | mcp-servers “Permissions”、permissions “Actions” |
| v2 skill 的屏蔽手段 | 权限 `{ action: 'skill', resource: '<skill-id>', effect: 'deny' }`（`deny` = 从模型可见列表隐藏并拒绝加载） | skills “Permissions” |
| v2 有运行时 MCP / agent / skill API | ✅ SDK 暴露：`mcp.{list,add,remove,connect,disconnect,catalog}`、`agent.{list,get,switchAgent}`、`skill.list`、`session.skill` | `@opencode/client` 2.0.26 `client.d.ts` |
| `OPENCODE_CONFIG`（单文件）是否仍生效 | ✅ **本机 v2.0.18 实证生效**（v2 文档页未列，但私有 `opencode serve` 的 `/api/config` 把该文件列为配置源并合并其 `mcp`） | 本地 spawn serve + `GET /api/config` |
| `OPENCODE_CONFIG_DIR` | 会**整体替换全局配置目录**（丢掉用户全局 `opencode.json`/agents/skills），不适合做增量注入 | 源码 `global.ts` + 文档 |
| opencode serve 复用语义 | v1 复用外部 serve；v2 永不共享（自造密码 + 自选端口）；桥接**每 profile 一个 adapter / 一个 serve** | `src/agent/opencode/server.ts`、`agent-runtime.ts` |
| claude 追加系统提示词 | 走 `--append-system-prompt-file` 临时文件（argv 会吃 `<`/`>`） | `claude/adapter.ts` |
| codex 配置覆盖 | `codex exec -c key="value"`；桥接已在用 | `codex/argv.ts` |

### 2.2 角色注入「有没有更好的方式」——研究结论

问题：一期在 opencode v2 上因无 per-prompt `system`，是把桥接提示词**前置拼进 user 正文**（`transport-v2.ts:buildV2PromptText`），相对 v1 的顶层 `system` 字段略弱。

调研到的「更原生」写法只有一条：在配置里定义一个 agent `system` = 桥接提示词 + 角色，再 `switchAgent` 到它。**但 `system` 会替换 opencode 自带的 base prompt**（open 工具用法、todo、edit 等指导都在 base prompt 里），只做软约束就丢掉这些基础指导，风险大于收益；且没有任何「追加式 system」入口（`instructions` 配置项 v2 明确「接受但不加载」）。

**结论：opencode v2 保持一期的 per-prompt 前置注入，不改。** 角色本就是提示词层软限制，不是硬权限；为它替换 opencode base prompt 得不偿失。真正值得在 2b 做的是 MCP / skill 的**白名单强制**（本节其余部分），机制上不再依赖角色注入路径。

> 备选（记入 backlog，不在 2b 实施）：提供「强角色」模式，用 `agents.lark_role.system` 承载完整桥接提示词并 `switchAgent`，换来强 system、放弃 opencode base prompt。默认关闭。

### 2.3 强制生效的手段排序（opencode）

| 手段 | 能力 | 评价 |
| --- | --- | --- |
| 生成 `OPENCODE_CONFIG` 文件（增量合并），写 `permissions` deny | MCP 工具（`<server>_*`）+ skill（`skill` id） | **首选**：不接管用户配置、不重启 server 之外无副作用；与一期「运行时注入 + 按能力降级」一致 |
| 同上，写 `mcp.servers.<name>.disabled: true` | 只控 MCP 连接 | 备选；但高优先级配置会**整对象替换**导致 disabled 丢失，不如 permissions 稳 |
| 运行时 SDK `mcp.disconnect/remove` | 只控 MCP 连接 | 备选；需要 location/已连接上下文，且 skill 无对应 API，语义不齐 |

**首选 = `OPENCODE_CONFIG` + `permissions` deny**：MCP 与 skill 统一走权限表，天然「隐藏但可保留连接」。

### 2.4 需要顺手修正的 2a 事实错误

`src/agent/role-catalog.ts`：
- 注释与测试把 `mcp.servers` 说成「旧格式」、`mcp.<name>` 说成「新格式」，**恰好反过来**：v1 = `mcp.<name>`，v2 = `mcp.servers`。代码两种都认（正确），但要改注释、测试命名与 §5.3 的措辞。
- transport 识别只用 `type`，未看 `enabled/disabled`；2b 需要真实「是否启用」，故发现层要额外读 `disabled`（v2）/ `enabled`（v1）。

## 3. 目标

1. 勾选落盘的 `mcpEnabled` / `skillsEnabled` 在**支持强制的端**真正生效：
   - **claude**：MCP 白名单 → 只保留选中 server（`--mcp-config` + `--strict-mcp-config`）；skill 仍只读（无强制手段）。
   - **opencode（v1 与 v2）**：MCP + skill 白名单 → 生成 `OPENCODE_CONFIG`，用 `permissions` deny 掉未选中的。
   - **codex**：MCP 只读、无 skill → 不强制，UI 明确标注。
2. 语义与 2a 三态一致：`undefined` = 跟随原生（不注入）；`[]` = 全部禁用；`string[]` = 仅允许集合。
3. 强制失败一律**降级为不注入**（宁可放开，不可误锁死），并在响应/日志可诊断。
4. 不改一期角色注入路径；不改 2a 的 `/api/role` 契约与前端勾选三态。

## 4. 非目标（YAGNI）

- 不实现 §2.2 的「强角色」agent 模式。
- 不做 opencode 运行时 MCP/skill API（首选是配置注入；运行时 API 记 backlog）。
- 不引入新依赖；不写用户 agent 配置目录本体（`OPENCODE_CONFIG` 只读合并我们自己的文件）。
- 不改 codex（只读）。

## 5. 架构与数据流

### 5.1 白名单从 policy 传到 adapter

`evaluateRunPolicy`（`src/policy/run-policy.ts`）已读 `profileConfig.role`。扩展：

```ts
export interface RunPolicyAllow {
  // ...既有字段
  rolePrompt?: string;
  /** 本次运行生效的 MCP 白名单；undefined = 不限制。 */
  roleMcpEnabled?: string[];
  /** 本次运行生效的 skill 白名单；undefined = 不限制。 */
  roleSkillsEnabled?: string[];
}
```

- 归一化复用 `normalizeRole` 的 `normalizeNameList` 语义：空数组保持空数组（= 全部禁用），非空为显式集合，缺失不传。
- `RunExecutor`（`src/runtime/run-executor.ts:106` 附近）把两者塞进 `AgentRunOptions`（`src/agent/types.ts` 增 `roleMcpEnabled?` / `roleSkillsEnabled?`）。
- `policyFingerprint` **不**纳入白名单（白名单变化不应使运行被拒/重签）；如需缓存一致性再议。

### 5.2 opencode：`OPENCODE_CONFIG` 注入

新增 `src/agent/opencode/role-config.ts`（纯函数，易测）：

```ts
export interface OpencodeRoleInjection {
  /** 生成的配置对象；无任何限制时返回 undefined（不注入）。 */
  config: Record<string, unknown> | undefined;
  /** 未选中但来自目录、应被 deny 的 server / skill 名。 */
  deniedMcp: string[];
  deniedSkills: string[];
}

/** v2：mcp.servers.<name> + permissions deny。 */
export function buildOpencodeV2RoleConfig(input: {
  mcpEnabled?: string[];
  skillsEnabled?: string[];
  knownMcp: string[];
  knownSkills: string[];
}): OpencodeRoleInjection;

/** v1：mcp.<name>.enabled=false。 */
export function buildOpencodeV1RoleConfig(input: { ... }): OpencodeRoleInjection;
```

生成规则（v2）：

```jsonc
{
  "permissions": [
    { "action": "<server>_*", "resource": "*", "effect": "deny" },   // 每个未选中的 MCP server
    { "action": "skill", "resource": "<skill-id>", "effect": "deny" } // 每个未选中的 skill
  ]
}
```

- `mcpEnabled === []` → 对**目录里已知**的每个 server 生成 deny；`mcpEnabled === [a]` → 只对已知但不在 `[a]` 的生成 deny。**只 deny 已知集合**，避免用通配 deny 误伤未知 server（也不给「未知白名单」挖坑）。
- `skillsEnabled` 同理，按已知 skill id。
- 两者都无限制 → `config === undefined` → 不传 `OPENCODE_CONFIG`。

落地：

- `OpencodeAdapter.prepareRun(opts)` 里（`server.start()` 之前）用 `buildOpencodeV1/V2RoleConfig` 生成配置；非空则写入 `<profileDir>/opencode-role.json`，并把 `OPENCODE_CONFIG` 传进 `OpencodeServer` 的 spawn env。
- `OpencodeServer`（`src/agent/opencode/server.ts`）：`ServeOptions` 增 `extraEnv?: Record<string,string>`，spawn 时与既有 `OPENCODE_SERVER_PASSWORD` 合并。**注意**：v1 复用外部 serve 的分支无法注入；复用即视为「无强制」（与 2a §1 一致）。
- **生效时机**：`OPENCODE_CONFIG` 在 serve **启动时**读取。因此：
  - 首次 `prepareRun` → 生成并注入，此后该 profile 的所有 run 生效。
  - 用户中途改白名单 → 检测到生成配置的指纹变化时，**重启该 profile 的 serve**（`server.stop()` + 重新 `start()`），并把该 profile 的 `session-consumer` 全部 `close`（避免挂在旧 SSE 上）。重启会结束进行中的会话（已 idle 的会话在 opencode 侧持久化，`--resume`/sessionId 可续）。
  - 若不愿中途重启，可退化为「下次 profile 启动生效」并在 UI 文案注明；设计取「自动重启」为默认，`LARK_CHANNEL_OPENCODE_NO_ROLE_RESTART=1` 可关。

### 5.3 claude：`--mcp-config` + `--strict-mcp-config`

- claude 需要**完整 server 定义**（`--strict-mcp-config` 会忽略其它所有 MCP 配置），因此发现层要能给出定义，而不只是名字/transport。
- 扩展 `src/agent/role-catalog.ts`：`discoverClaudeMcp` 增一个返回 `Map<name, rawDef>` 的旁路（或让 `McpServerEntry` 增可选 `raw?: unknown`，仅内存用、不进 API 响应）。
- 每次 run（`ClaudeAdapter.run`）：
  - `mcpEnabled` 缺失 → 不加任何 flag（跟随原生）。
  - 否则写临时 `mcp-config.json` = `{ "mcpServers": <过滤后的定义> }`，argv 追加 `--mcp-config <path> --strict-mcp-config`；onExit 清理（复用 `writeSystemPromptFile` 的临时目录模式）。
  - 目录不可用（读不到 `~/.claude.json`/`.mcp.json`）→ 降级为**不注入**（不写 strict，避免把所有 server 清空）。
- skill：claude 端保持只读（不加 flag）。

### 5.4 codex

- MCP 只读、无 skill：**不改行为**。UI 文案改为「只读：已知目录，不支持本桥接强制」。

### 5.5 前端

- `web/src/views/RoleView.tsx`：把 2a 的固定提示「当前仅保存选择，尚未强制生效（2b 落地）」替换为**按端能力**的文案：
  - `capabilities.mcp === 'control'` → 「保存后在下次运行时强制生效」；
  - `'readonly'` → 「只读：列出但本桥接不强制」；
  - `'none'` → 不渲染该段（保持 2a）。
- 能力表不变（claude mcp control/skills readonly；codex mcp readonly/skills none；opencode mcp+skills control）。

## 6. 错误处理

| 场景 | 结果 |
| --- | --- |
| 目录探测失败（`available:false`） | **不注入**该维度的强制（降级放开），日志 warn；不影响运行 |
| 白名单里的名字在目录中不存在 | 忽略该名字（无法定义/deny），不报错 |
| `OPENCODE_CONFIG` 生成/写盘失败 | 降级不注入 + warn；运行继续 |
| serve 重启失败 | 回滚到「不重启 + 沿用旧配置」，warn；下次 profile 启动再试 |
| claude 临时文件写失败 | 不注入（跟随原生），warn |
| 角色文本（一期）语义 | 完全不变 |

## 7. 测试计划

- 单元 `tests/unit/agent/opencode/role-config.test.ts`：
  - v2：`undefined` → 无 config；`[]` → 对全部 known 生成 `<server>_*` / `skill` deny；`[a]` → 仅 deny 其余；未知名忽略。
  - v1：`mcp.<name>.enabled=false` 形状；`undefined` → 无 config。
- 单元 `tests/unit/agent/role-catalog.test.ts`：补 `disabled`(v2)/`enabled`(v1) 解析；补 claude 原始定义旁路；修正「v1/v2 形状」命名与注释。
- 单元 `tests/unit/agent/opencode/server.test.ts`：`extraEnv` 合并进 spawn env（`OPENCODE_CONFIG` 出现）。
- 单元 `tests/unit/agent/claude/adapter.test.ts`：`mcpEnabled` 缺失无 flag；`[]`/`[a]` 生成 `--mcp-config` + `--strict-mcp-config` 且 JSON 正确；目录不可用不注入。
- 单元 `tests/unit/ui/role-api.test.ts`：不变（三态契约保持）。
- 集成 `tests/integration/ui/server.test.ts`：不变。
- 前端：`tsc -p web/tsconfig.json` + `pnpm build:web`。
- 门禁：`pnpm exec vitest run <paths>`、`pnpm typecheck`、`pnpm build`、前端 tsc。

## 8. 验收标准

1. claude：勾选 MCP 子集后，run 期间只有选中 server 可用（`--strict-mcp-config`）；不勾选则行为与今天一致。
2. opencode v1/v2：勾选 MCP/skill 后，未选中者从模型可见列表中消失；`[]` = 全禁；不勾选 = 跟随原生。
3. codex：无行为变化，UI 标注只读。
4. 探测失败 / 写盘失败一律放开（不误锁死），有日志。
5. 零新依赖；相关 vitest、`pnpm typecheck`、`pnpm build`、前端 tsc 全绿。
6. 不写入用户 agent 配置目录本体。

## 9. 待验证（实施前/实施中 spike）

1. **`OPENCODE_CONFIG` 与 project 配置的优先级**：本机只在「global + 该文件」下验证过（文件被合并）。需确认项目级 `opencode.json` 不会覆盖我们的 `permissions` deny（文档称权限规则是**追加 + 后者胜**，但优先级顺序需实测）。若被覆盖，改用「同时写 `disabled: true`」或运行时 `mcp.disconnect` 兜底。
2. **v1 是否同样支持 `OPENCODE_CONFIG`**：需在有 v1 的环境实测（文档 v1 支持，但桥接的 v1 复用分支不注入，仅自起 serve 时生效）。
3. **claude `--mcp-config` 的 server 定义透传**：确认 `~/.claude.json` 的 server 定义可原样放进 `mcpServers`（含 `command/args/env` 或 `type/url/headers`）。

## 10. 分期建议

- **2b-1（open 集，本次重点）**：opencode v1+v2 的 `OPENCODE_CONFIG` 注入（`role-config.ts` + server `extraEnv` + adapter 生成/重启）+ role-catalog 事实修正。
- **2b-2**：claude `--mcp-config` 强制 + 定义旁路。
- **2b-3**：前端按端文案 + 全量验收。
- backlog：运行时 MCP/skill API、「强角色」agent 模式、`OPENCODE_CONFIG_DIR`、claude skill 强制。
