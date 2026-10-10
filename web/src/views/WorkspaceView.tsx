import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { DirListing, ProjectView, ProjectsView } from "@/lib/types";
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
import { toast } from "@/components/ui/sonner";

export function WorkspaceView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<ProjectsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(
    () =>
      apiGet<ProjectsView>(`/api/projects?${q}`)
        .then((v) => { setView(v); setError(null); })
        .catch((e) => setError(String(e.message ?? e))),
    [q],
  );
  useEffect(() => { void load(); }, [load]);

  async function setRoot(path: string) {
    setBusy(true);
    try {
      await apiPost(`/api/workspace/root?${q}`, { path });
      toast.success("已设置工作空间目录");
      setPickerOpen(false);
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function pull(id?: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/pull?${q}`, id ? { id } : {});
      toast.success("已拉取");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/remove?${q}`, { id });
      toast.success("已移除（未删除磁盘目录）");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function setBranch(id: string, branch: string) {
    try {
      await apiPost(`/api/projects/branch?${q}`, { id, branch });
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!view) return <p className="text-muted-foreground text-sm">加载中…</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>工作空间目录</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>更换目录…</Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
            {view.workspaceDir ?? "（未设置）"}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            项目仓库默认克隆到该目录下；默认值来自启动参数 <code>--workspace</code>，可修改。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>项目（{view.projects.length}）</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => pull()}>全部拉取</Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>+ 添加项目</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {view.projects.length === 0 && (
            <p className="text-sm text-muted-foreground">还没有项目，点「添加项目」填入仓库地址。</p>
          )}
          {view.projects.map((p) => <ProjectRow key={p.id} project={p} busy={busy} onPull={pull} onRemove={remove} onBranch={setBranch} />)}
        </CardContent>
      </Card>

      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} busy={busy} onPick={setRoot} />
      <AddProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        busy={busy}
        onAdd={async (repoUrl, branch) => {
          setBusy(true);
          try {
            await apiPost(`/api/projects?${q}`, { projects: [{ repoUrl, branch }] });
            toast.success("已添加并检出");
            setAddOpen(false);
            await load();
          } catch (e) {
            toast.error(String((e as Error).message ?? e));
          } finally { setBusy(false); }
        }}
      />
    </div>
  );
}

function statusBadge(p: ProjectView) {
  if (!p.exists) return <Badge variant="destructive">未检出</Badge>;
  if (p.status.dirty) return <Badge variant="secondary">有本地改动</Badge>;
  if (p.status.behind > 0) return <Badge variant="secondary">落后 {p.status.behind}</Badge>;
  return <Badge variant="success">已最新</Badge>;
}

function ProjectRow({ project, busy, onPull, onRemove, onBranch }: {
  project: ProjectView;
  busy: boolean;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onBranch: (id: string, branch: string) => void;
}) {
  const [branch, setBranch] = useState(project.branch);
  useEffect(() => { setBranch(project.branch); }, [project.branch]);
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{project.name} {statusBadge(project)}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{project.repoUrl}</div>
      </div>
      <Input
        className="h-8 w-[130px]"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onBlur={() => { if (branch.trim() && branch !== project.branch) onBranch(project.id, branch.trim()); }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onPull(project.id)}>拉取</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(project.id)}>移除</Button>
    </div>
  );
}

function DirectoryPicker({ open, onOpenChange, busy, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback((path?: string) => {
    setError(null);
    apiGet<DirListing>(`/api/workspace/dir${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then(setListing)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => { if (open) browse(); }, [open, browse]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription>从本机磁盘选择工作空间根目录。</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {listing && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Button variant="outline" size="sm" onClick={() => listing.parent && browse(listing.parent)} disabled={!listing.parent}>
                ↑ 上一级
              </Button>
              <span className="truncate font-mono text-xs text-muted-foreground">{listing.path || "此电脑"}</span>
            </div>
            <div className="max-h-[46vh] divide-y overflow-y-auto rounded-md border">
              {(listing.roots ?? listing.dirs).map((d) => (
                <button
                  key={d.path}
                  className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => browse(d.path)}
                >
                  📁 {d.name}
                </button>
              ))}
              {(listing.roots ?? listing.dirs).length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">（没有子目录）</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">已选：<span className="font-mono">{listing.path || "—"}</span></p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => listing?.path && onPick(listing.path)} disabled={busy || !listing?.path}>
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddProjectDialog({ open, onOpenChange, busy, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onAdd: (repoUrl: string, branch: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  useEffect(() => { if (open) { setRepoUrl(""); setBranch("main"); } }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>填入仓库地址与分支，保存后会 clone 到工作空间目录下。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>仓库地址</Label>
            <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://… 或 git@…" />
          </div>
          <div className="space-y-1.5">
            <Label>分支</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => onAdd(repoUrl.trim(), branch.trim() || "main")} disabled={busy || !repoUrl.trim()}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
