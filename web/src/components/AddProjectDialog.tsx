import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { GitAccount, RemoteRepo, ReposView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { providerLabel } from "@/components/GitAccountCard";

export interface AddProjectItem {
  repoUrl: string;
  branch: string;
  name?: string;
  accountId?: string;
}

export function AddProjectDialog({
  open,
  onOpenChange,
  accounts,
  busy,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: GitAccount[];
  busy: boolean;
  onAdd: (items: AddProjectItem[]) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  /** Latest repo-list request id; older in-flight responses are ignored. */
  const reposReqRef = useRef(0);

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [manualAccountId, setManualAccountId] = useState("");

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setRepos([]);
    setReposError(null);
    setSelected({});
    setBranches({});
    setRepoUrl("");
    setBranch("main");
    setManualAccountId("");
  }, [open, accounts]);

  const loadRepos = useCallback(async (id: string) => {
    if (!id) return;
    const req = ++reposReqRef.current;
    setReposLoading(true);
    setReposError(null);
    try {
      const v = await apiGet<ReposView>(`/api/git/repos?account=${encodeURIComponent(id)}`);
      if (req !== reposReqRef.current) return;
      setRepos(v.repos);
    } catch (e) {
      if (req !== reposReqRef.current) return;
      setReposError(String((e as Error).message ?? e));
    } finally {
      if (req === reposReqRef.current) setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Switching accounts invalidates any prior selection/branch cache.
    setSelected({});
    setBranches({});
    void loadRepos(accountId);
  }, [open, accountId, loadRepos]);

  async function loadBranches(repo: RemoteRepo) {
    if (branches[repo.id]) return;
    try {
      const v = await apiGet<{ branches: string[] }>(
        `/api/git/branches?account=${encodeURIComponent(accountId)}&repo=${encodeURIComponent(repo.fullName)}`,
      );
      setBranches((prev) => ({ ...prev, [repo.id]: v.branches }));
    } catch {
      setBranches((prev) => ({ ...prev, [repo.id]: [] }));
    }
  }

  function toggle(repo: RemoteRepo) {
    const wasSelected = selected[repo.id] !== undefined;
    setSelected((prev) => {
      const next = { ...prev };
      if (next[repo.id] !== undefined) {
        delete next[repo.id];
      } else {
        next[repo.id] = repo.defaultBranch || "main";
      }
      return next;
    });
    // Side effect kept out of the state updater (StrictMode double-invokes it).
    if (!wasSelected) void loadBranches(repo);
  }

  function addFromAccount() {
    const items: AddProjectItem[] = [];
    for (const repo of repos) {
      const b = selected[repo.id];
      if (b === undefined) continue;
      items.push({
        repoUrl: repo.httpsUrl || repo.sshUrl,
        branch: b || repo.defaultBranch || "main",
        name: repo.name,
        accountId,
      });
    }
    if (items.length === 0) {
      toast.error("请先勾选仓库");
      return;
    }
    onAdd(items);
  }

  function addManual() {
    if (!repoUrl.trim()) {
      toast.error("请填写仓库地址");
      return;
    }
    onAdd([
      {
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || "main",
        ...(manualAccountId ? { accountId: manualAccountId } : {}),
      },
    ]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>从已保存的 Git 账号选择仓库，或手动填写仓库地址。</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="account">
          <TabsList>
            <TabsTrigger value="account">从账号选择</TabsTrigger>
            <TabsTrigger value="manual">手动输入地址</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="space-y-3">
            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                还没有 Git 账号，请先在「Git 账号」卡片添加，或切到「手动输入地址」。
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>账号</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择账号" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label}（{providerLabel(a.provider)}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {reposLoading && <p className="text-sm text-muted-foreground">正在获取仓库…</p>}
                {reposError && <p className="text-sm text-destructive">{reposError}</p>}
                {!reposLoading && !reposError && repos.length === 0 && (
                  <p className="text-sm text-muted-foreground">该账号没有可见仓库。</p>
                )}
                <div className="max-h-[40vh] divide-y overflow-y-auto rounded-md border">
                  {repos.map((repo) => {
                    const checked = selected[repo.id] !== undefined;
                    const current = selected[repo.id] ?? repo.defaultBranch ?? "main";
                    const options = branches[repo.id] ?? [];
                    return (
                      <div key={repo.id} className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer"
                          checked={checked}
                          onChange={() => toggle(repo)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 truncate text-sm font-medium">
                            <span className="truncate">{repo.fullName}</span>
                            {repo.private && <Badge variant="secondary">私有</Badge>}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {repo.httpsUrl || repo.sshUrl}
                          </div>
                        </div>
                        {checked &&
                          (options.length > 0 ? (
                            <Select
                              value={current}
                              onValueChange={(v) => setSelected((p) => ({ ...p, [repo.id]: v }))}
                            >
                              <SelectTrigger className="w-[150px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {!options.includes(current) && <SelectItem value={current}>{current}</SelectItem>}
                                {options.map((b) => (
                                  <SelectItem key={b} value={b}>
                                    {b}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              className="h-8 w-[150px]"
                              value={current}
                              onChange={(e) => setSelected((p) => ({ ...p, [repo.id]: e.target.value }))}
                              placeholder="分支"
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
                <DialogFooter>
                  <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button
                    disabled={busy || Object.keys(selected).length === 0}
                    onClick={addFromAccount}
                  >
                    添加选中（{Object.keys(selected).length}）
                  </Button>
                </DialogFooter>
              </>
            )}
          </TabsContent>

          <TabsContent value="manual" className="space-y-3">
            <div className="space-y-1.5">
              <Label>仓库地址</Label>
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://… 或 git@…" />
            </div>
            <div className="space-y-1.5">
              <Label>分支</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </div>
            {accounts.length > 0 && (
              <div className="space-y-1.5">
                <Label>账号（可选，私有仓库拉取用）</Label>
                <Select
                  value={manualAccountId || "none"}
                  onValueChange={(v) => setManualAccountId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不使用账号</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button disabled={busy || !repoUrl.trim()} onClick={addManual}>
                添加
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
