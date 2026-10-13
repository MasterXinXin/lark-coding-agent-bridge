import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type {
  CatalogSection,
  RoleCatalogView,
  RoleView as RoleViewModel,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";

const INJECTION_LABEL: Record<string, string> = {
  "append-system-prompt": "追加系统提示文件",
  "stdin-prefix": "前缀进标准输入",
  "prompt-body-system": "每轮 system 字段",
};

/** Stored selection → checked set. Absent whitelist means "unlimited" (all on). */
function initialChosen(items: Array<{ name: string }>, stored?: string[]): Set<string> {
  if (stored === undefined) return new Set(items.map((i) => i.name));
  const names = new Set(items.map((i) => i.name));
  return new Set(stored.filter((n) => names.has(n)));
}

/** Checked set → request body value: all = null (unrestricted), else the checked subset. */
function chosenToBody(chosen: Set<string>, names: string[]): string[] | null {
  if (names.every((n) => chosen.has(n))) return null;
  return names.filter((n) => chosen.has(n));
}

const CAPABILITY_NOTE: Record<"control" | "readonly" | "none", string> = {
  control: "保存后在下一次运行时强制生效（未勾选的会被禁用）。",
  readonly: "只读：仅列出，本桥接不改动该端的配置。",
  none: "",
};

function ScopeSection({
  title,
  capability,
  section,
  chosen,
  onToggle,
}: {
  title: string;
  capability: "control" | "readonly" | "none";
  section: CatalogSection<{ name: string; transport?: string; source: string }>;
  chosen: Set<string>;
  onToggle: (name: string) => void;
}) {
  if (capability === "none") return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {title}
        {capability === "readonly" ? (
          <span className="text-muted-foreground"> · 只读</span>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">{CAPABILITY_NOTE[capability]}</p>
      {!section.available ? (
        <p className="text-xs text-muted-foreground">{section.error ?? "无法读取"}（重试见上）。</p>
      ) : section.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">未发现条目。</p>
      ) : (
        <div className="space-y-1">
          {section.items.map((item) => (
            <label key={item.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">
                {item.name}
                {item.transport ? <span className="text-muted-foreground"> · {item.transport}</span> : null}
                <span className="text-muted-foreground"> · {item.source}</span>
              </span>
              <Switch
                aria-label={item.name}
                checked={chosen.has(item.name)}
                disabled={capability !== "control"}
                onCheckedChange={() => onToggle(item.name)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoleView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<RoleViewModel | null>(null);
  const [catalog, setCatalog] = useState<RoleCatalogView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mcpChosen, setMcpChosen] = useState<Set<string>>(new Set());
  const [skillsChosen, setSkillsChosen] = useState<Set<string>>(new Set());
  const [mcpDirty, setMcpDirty] = useState(false);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyCatalog = useCallback((c: RoleCatalogView, v: RoleViewModel) => {
    setCatalog(c);
    setMcpChosen(initialChosen(c.mcp.items, v.mcpEnabled));
    setSkillsChosen(initialChosen(c.skills.items, v.skillsEnabled));
    setMcpDirty(false);
    setSkillsDirty(false);
  }, []);

  const loadCatalog = useCallback(
    async (v: RoleViewModel) => {
      setCatalogError(null);
      try {
        applyCatalog(await apiGet<RoleCatalogView>(`/api/role/catalog?${q}`), v);
      } catch (e) {
        setCatalog(null);
        setCatalogError(String((e as Error).message ?? e));
      }
    },
    [q, applyCatalog],
  );

  const load = useCallback(async () => {
    setError(null);
    setCatalogError(null);
    let v: RoleViewModel;
    try {
      v = await apiGet<RoleViewModel>(`/api/role?${q}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return;
    }
    setView(v);
    setPrompt(v.prompt);
    await loadCatalog(v);
  }, [q, loadCatalog]);
  useEffect(() => {
    void load();
  }, [load]);

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, name: string) {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setter(next);
  }

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { prompt };
      if (catalog && view) {
        if (view.capabilities.mcp === "control" && catalog.mcp.available && mcpDirty) {
          body.mcpEnabled = chosenToBody(mcpChosen, catalog.mcp.items.map((i) => i.name));
        }
        if (view.capabilities.skills === "control" && catalog.skills.available && skillsDirty) {
          body.skillsEnabled = chosenToBody(skillsChosen, catalog.skills.items.map((i) => i.name));
        }
      }
      const v = await apiPost<RoleViewModel>(`/api/role?${q}`, body);
      setView(v);
      setPrompt(v.prompt);
      setMcpDirty(false);
      setSkillsDirty(false);
      toast.success("已保存角色设定");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!view) return <p className="text-muted-foreground text-sm">加载中…</p>;

  const liveText = view.live ? "保存后下一轮运行生效" : "该 profile 未在线，保存后下次启动生效";
  const showScope = view.capabilities.mcp !== "none" || view.capabilities.skills !== "none";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>角色设定</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            这是该 profile 的系统提示词软限制：作为「## 角色设定」段追加在 bridge 运行约定之后，对每次运行生效，
            用于约束 agent 的身份与风格。它不是硬权限——真正的权限在「配置」页的访问控制里。
          </p>
          <p className="text-xs text-muted-foreground">
            注入方式：{INJECTION_LABEL[view.injection] ?? view.injection} · {liveText}
          </p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：你是一名严谨的财务分析师，回答用中文，先给结论再给依据。"
          />
        </CardContent>
      </Card>

      {showScope ? (
        <Card>
          <CardHeader>
            <CardTitle>MCP / Skill 范围</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              勾选会保存到该 profile。全选 = 不限制；全部取消 = 全部禁用。是否强制生效取决于该端能力：
              支持控制的端在下一次运行时生效；只读端仅展示。
            </p>
            {catalogError ? (
              <p className="text-destructive text-sm">
                目录拉取失败：{catalogError}{" "}
                <Button size="sm" variant="outline" onClick={() => void loadCatalog(view)}>
                  重试
                </Button>
              </p>
            ) : catalog ? (
              <>
                <ScopeSection
                  title="MCP servers"
                  capability={view.capabilities.mcp}
                  section={catalog.mcp}
                  chosen={mcpChosen}
                  onToggle={(n) => {
                    setMcpDirty(true);
                    toggle(mcpChosen, setMcpChosen, n);
                  }}
                />
                <ScopeSection
                  title="Skills"
                  capability={view.capabilities.skills}
                  section={catalog.skills}
                  chosen={skillsChosen}
                  onToggle={(n) => {
                    setSkillsDirty(true);
                    toggle(skillsChosen, setSkillsChosen, n);
                  }}
                />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">目录加载中…</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
