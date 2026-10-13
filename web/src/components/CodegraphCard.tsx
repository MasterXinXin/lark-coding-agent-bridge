import { useState } from "react";
import { apiPost } from "@/lib/api";
import type { CodegraphSystemView, StartJobResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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

type InstallMethod = "script" | "npm";

/**
 * The workspace page's CodeGraph card: shows installed CLI + MCP state and
 * offers install / wire / init-all / sync-all actions. Every action starts a
 * background job; the parent opens the shared JobProgressDialog for the id.
 */
export function CodegraphCard({
  profile,
  system,
  busy,
  unindexedCount,
  onJob,
  onRefresh,
}: {
  profile: string;
  system: CodegraphSystemView | null;
  busy: boolean;
  unindexedCount: number;
  onJob: (jobId: string) => void;
  onRefresh: () => void;
}) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [method, setMethod] = useState<InstallMethod>("script");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [posting, setPosting] = useState(false);

  async function post(path: string, body: unknown) {
    setPosting(true);
    try {
      const { jobId } = await apiPost<StartJobResponse>(`${path}?${q}`, body);
      setConfirmOpen(false);
      onJob(jobId);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setPosting(false);
    }
  }

  const loaded = system !== null;
  const installed = system?.cli.installed ?? false;
  const mcpState = system?.mcp.state ?? "unknown";
  const disabled = busy || posting;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>CodeGraph 代码索引</CardTitle>
        <div className="flex items-center gap-2">
          {!loaded ? (
            <Badge variant="secondary">状态未知</Badge>
          ) : installed ? (
            <Badge variant="success">CLI {system?.cli.version ?? "已安装"}</Badge>
          ) : (
            <Badge variant="destructive">CLI 未安装</Badge>
          )}
          {loaded &&
            installed &&
            (mcpState === "installed" ? (
              <Badge variant="success">MCP 已接入</Badge>
            ) : mcpState === "missing" ? (
              <Badge variant="secondary">MCP 未接入</Badge>
            ) : (
              <Badge variant="secondary">MCP 未知</Badge>
            ))}
          <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loaded && !installed && (
          <>
            <p className="text-xs text-muted-foreground">
              未检测到 codegraph CLI。安装后可为每个项目建立本地代码知识图谱，供 opencode / codex
              等 agent 查询。
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>安装方式</Label>
                <Select
                  value={method}
                  onValueChange={(v) => setMethod(v as InstallMethod)}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="script">官方安装脚本（推荐）</SelectItem>
                    <SelectItem value="npm">npm 全局安装</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={disabled} onClick={() => setConfirmOpen(true)}>
                安装 CodeGraph
              </Button>
            </div>
          </>
        )}

        {loaded && installed && mcpState !== "installed" && (
          <>
            <p className="text-xs text-muted-foreground">
              CLI 已安装，但本机 agent 尚未接入 codegraph MCP。接入后需重启 bridge / opencode
              才生效。
            </p>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => void post("/api/codegraph/mcp/install", {})}
            >
              接入 CodeGraph MCP
            </Button>
          </>
        )}

        {loaded && installed && mcpState === "installed" && (
          <>
            <p className="text-xs text-muted-foreground">
              MCP 已接入
              {system?.mcp.configPath ? `（${system.mcp.configPath}）` : ""}
              。建索引需手动发起（首次拉取不会自动建）；已索引项目在 git 拉取确有文件更新时自动增量同步。
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={disabled || unindexedCount === 0}
                onClick={() => void post("/api/codegraph/init", { all: true })}
              >
                初始化全部未索引项目{unindexedCount > 0 ? `（${unindexedCount}）` : ""}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void post("/api/codegraph/sync", { all: true })}
              >
                全部同步
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>安装 CodeGraph</DialogTitle>
            <DialogDescription>
              {method === "npm"
                ? "将执行 npm i -g @colbymchenry/codegraph。"
                : "将执行 codegraph 官方安装脚本，需要联网。"}
              安装完成后会自动尝试接入本机 agent（codegraph install --yes）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={disabled}>
              取消
            </Button>
            <Button
              onClick={() => void post("/api/codegraph/cli/install", { method })}
              disabled={disabled}
            >
              确认安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
