import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { RoleView as RoleViewModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";

const INJECTION_LABEL: Record<string, string> = {
  "append-system-prompt": "追加系统提示文件",
  "stdin-prefix": "前缀进标准输入",
  "prompt-body-system": "每轮 system 字段",
};

export function RoleView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<RoleViewModel | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<RoleViewModel>(`/api/role?${q}`)
      .then((v) => {
        setView(v);
        setPrompt(v.prompt);
        setError(null);
      })
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, [q]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const v = await apiPost<RoleViewModel>(`/api/role?${q}`, { prompt });
      setView(v);
      setPrompt(v.prompt);
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
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
