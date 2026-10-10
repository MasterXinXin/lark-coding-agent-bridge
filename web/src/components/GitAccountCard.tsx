import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import type { AccountTestResult, AccountsView, GitAccount, GitProvider } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

export const PROVIDER_OPTIONS: { value: GitProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitea", label: "Gitea" },
  { value: "other", label: "其他（仅手动地址）" },
];

export function providerLabel(provider: GitProvider): string {
  return PROVIDER_OPTIONS.find((p) => p.value === provider)?.label ?? provider;
}

export function GitAccountCard({ onChanged }: { onChanged?: (accounts: GitAccount[]) => void }) {
  const [accounts, setAccounts] = useState<GitAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GitAccount | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const apply = useCallback(
    (next: GitAccount[]) => {
      setAccounts(next);
      onChanged?.(next);
    },
    [onChanged],
  );

  const load = useCallback(
    () =>
      apiGet<AccountsView>("/api/git/accounts")
        .then((v) => {
          apply(v.accounts);
          setError(null);
        })
        .catch((e) => setError(String((e as Error).message ?? e))),
    [apply],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    setBusy(true);
    try {
      const v = await apiDelete<AccountsView>(`/api/git/accounts?id=${encodeURIComponent(id)}`);
      apply(v.accounts);
      toast.success("已移除账号");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Git 账号（{accounts.length}）</CardTitle>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          + 添加账号
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          账号全局共享（机器级），令牌只存本机加密库，不会回显；私有仓库拉取时自动注入。
        </p>
        {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
        {accounts.length === 0 && <p className="text-sm text-muted-foreground">还没有账号。</p>}
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 truncate text-sm font-medium">
                <span className="truncate">{a.label}</span>
                <Badge variant="outline">{providerLabel(a.provider)}</Badge>
                {a.hasToken ? (
                  <Badge variant="success">已保存令牌</Badge>
                ) : (
                  <Badge variant="secondary">无令牌</Badge>
                )}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {a.baseUrl || "—"}
                {a.username ? ` · ${a.username}` : ""}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(a);
                setDialogOpen(true);
              }}
            >
              编辑
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(a.id)}>
              移除
            </Button>
          </div>
        ))}
      </CardContent>
      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        onSaved={(v) => {
          apply(v.accounts);
          setDialogOpen(false);
        }}
      />
    </Card>
  );
}

function AccountDialog({
  open,
  onOpenChange,
  account,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: GitAccount | null;
  onSaved: (v: AccountsView) => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<GitProvider>("github");
  const [baseUrl, setBaseUrl] = useState("https://api.github.com");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<AccountTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(account?.label ?? "");
    setProvider(account?.provider ?? "github");
    setBaseUrl(account?.baseUrl ?? "https://api.github.com");
    setUsername(account?.username ?? "");
    setToken("");
    setTest(null);
  }, [open, account]);

  function onProviderChange(next: GitProvider) {
    setProvider(next);
    setTest(null);
    if (!account) {
      setBaseUrl(
        next === "github"
          ? "https://api.github.com"
          : next === "gitlab"
            ? "https://gitlab.com"
            : next === "gitea"
              ? "https://gitea.com"
              : "",
      );
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await apiPost<AccountTestResult>("/api/git/accounts/test", {
        ...(account ? { id: account.id } : {}),
        provider,
        baseUrl,
        username,
        token,
      });
      setTest(r);
    } catch (e) {
      setTest({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const v = await apiPost<AccountsView>("/api/git/accounts", {
        ...(account ? { id: account.id } : {}),
        label,
        provider,
        baseUrl,
        username,
        token,
      });
      toast.success(account ? "已更新账号" : "已添加账号");
      onSaved(v);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = label.trim().length > 0 && (provider === "other" || baseUrl.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? "编辑 Git 账号" : "添加 Git 账号"}</DialogTitle>
          <DialogDescription>
            PAT 只存本机加密库，保存后不再回显；留空表示不修改已保存的令牌。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>平台</Label>
            <Select value={provider} onValueChange={(v) => onProviderChange(v as GitProvider)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>账号名称</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：GitHub 工作号" />
          </div>
          <div className="space-y-1.5">
            <Label>服务地址</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={provider === "github" ? "https://api.github.com" : "https://gitlab.example.com"}
            />
          </div>
          <div className="space-y-1.5">
            <Label>用户名（可选）</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="仅用于展示与凭证提示" />
          </div>
          <div className="space-y-1.5">
            <Label>访问令牌（PAT）{account ? "（留空不改）" : ""}</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… / glpat-…"
              autoComplete="new-password"
            />
          </div>
          {test && (
            <p className={test.ok ? "text-sm text-success" : "text-sm text-destructive"}>
              {test.ok
                ? `连接成功${test.username ? `（${test.username}）` : ""}${
                    test.repoCount !== undefined ? `，可见 ${test.repoCount} 个仓库` : ""
                  }`
                : `连接失败：${test.message ?? "未知错误"}`}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={runTest}>
            测试连接
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !canSave} onClick={save}>
            {account ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
