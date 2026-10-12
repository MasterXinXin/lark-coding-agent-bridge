import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { JobStatus, JobView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const POLL_MS = 700;
/** Cap the client-side log buffer so a long job cannot grow state/DOM unbounded. */
const MAX_LOG_LINES = 2000;

function statusBadge(status: JobStatus): { variant: "secondary" | "success" | "destructive"; text: string } {
  if (status === "succeeded") return { variant: "success", text: "完成" };
  if (status === "failed") return { variant: "destructive", text: "失败" };
  return { variant: "secondary", text: "运行中" };
}

function stepLabel(status: JobStatus): string {
  if (status === "succeeded") return "完成";
  if (status === "failed") return "失败";
  return "进行中";
}

function stepDotClass(status: JobStatus): string {
  if (status === "succeeded") return "bg-success";
  if (status === "failed") return "bg-destructive";
  return "bg-primary animate-pulse";
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function kindLabel(kind: string): string {
  if (kind === "pull") return "拉取项目";
  if (kind === "add") return "添加项目";
  return "后台任务";
}

export function JobProgressDialog({
  jobId,
  open,
  onOpenChange,
  onFinished,
  onStatus,
}: {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
  /** Reports each status change so callers can keep a closed job observable. */
  onStatus?: (status: JobStatus) => void;
}) {
  const [logs, setLogs] = useState<JobView["logs"]>([]);
  const [snapshot, setSnapshot] = useState<JobView | null>(null);
  const [lost, setLost] = useState(false);
  const [transientErrors, setTransientErrors] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  /** Latest `onFinished` without making the polling effect depend on its identity. */
  const onFinishedRef = useRef(onFinished);
  /** Latest `onStatus` without making the polling effect depend on its identity. */
  const onStatusRef = useRef(onStatus);
  /** Job id we already reported as finished, so `onFinished` fires at most once. */
  const finishedForRef = useRef<string | null>(null);
  /** Last status handed to `onStatus`, so it only fires on actual changes. */
  const reportedStatusRef = useRef<JobStatus | null>(null);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    if (!open || !jobId) return;
    let cancelled = false;
    let lastSeq = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setLogs([]);
    setSnapshot(null);
    setLost(false);
    setTransientErrors(0);
    reportedStatusRef.current = null;

    const reportStatus = (next: JobStatus) => {
      if (reportedStatusRef.current === next) return;
      reportedStatusRef.current = next;
      onStatusRef.current?.(next);
    };

    const finish = () => {
      if (finishedForRef.current === jobId) return;
      finishedForRef.current = jobId;
      onFinishedRef.current();
    };

    const poll = async () => {
      try {
        const snap = await apiGet<JobView>(`/api/jobs/${encodeURIComponent(jobId)}?since=${lastSeq}`);
        if (cancelled) return;
        failures = 0;
        setTransientErrors(0);
        if (snap.logs.length > 0) {
          lastSeq = Math.max(lastSeq, ...snap.logs.map((l) => l.seq));
          setLogs((prev) => {
            const next = [...prev, ...snap.logs];
            return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
          });
        }
        setSnapshot(snap);
        reportStatus(snap.status);
        if (snap.status !== "running") {
          finish();
          return;
        }
      } catch (e) {
        if (cancelled) return;
        if ((e as Error & { status?: number }).status === 404) {
          setLost(true);
          reportStatus("failed");
          finish();
          return;
        }
        failures += 1;
        setTransientErrors(failures);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, jobId]);

  const status: JobStatus = snapshot?.status ?? "running";

  // Tick once per second while the job is running so the elapsed time stays live.
  useEffect(() => {
    if (!open || status !== "running") return;
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [open, status]);

  // Keep the log pane pinned to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, open]);

  const stepNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of snapshot?.steps ?? []) map.set(step.id, step.name);
    return map;
  }, [snapshot?.steps]);

  // Last log line carrying a "NN%" marker wins; git prints progress to stderr.
  const parsedPct = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const m = /(\d{1,3})%/.exec(logs[i].text);
      if (m) return Math.min(100, Math.max(0, Number(m[1])));
    }
    return null;
  }, [logs]);

  const displayPct = status === "succeeded" ? 100 : parsedPct;
  const elapsedMs = snapshot ? (snapshot.endedAt ?? nowTick) - snapshot.startedAt : 0;
  const badge =
    lost && !snapshot ? { variant: "secondary" as const, text: "状态丢失" } : statusBadge(status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="truncate">{snapshot?.label ?? "任务进度"}</DialogTitle>
            <Badge variant={badge.variant}>{badge.text}</Badge>
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
              {formatElapsed(elapsedMs)}
            </span>
          </div>
          <DialogDescription>{snapshot ? kindLabel(snapshot.kind) : "正在连接任务…"}</DialogDescription>
        </DialogHeader>

        {((!lost && status === "running") || displayPct !== null) && (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            {displayPct !== null ? (
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${displayPct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            )}
          </div>
        )}

        {snapshot && snapshot.steps.length > 0 && (
          <div className="space-y-1">
            {snapshot.steps.map((step) => (
              <div key={step.id} className="flex items-center gap-2 text-xs">
                <span className={cn("size-1.5 shrink-0 rounded-full", stepDotClass(step.status))} />
                <span className="truncate">{step.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{stepLabel(step.status)}</span>
              </div>
            ))}
          </div>
        )}

        <div
          ref={logRef}
          className="max-h-[45vh] min-h-[160px] overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
        >
          {logs.length === 0 && <p className="text-muted-foreground">等待输出…</p>}
          {logs.map((line) => (
            <div key={line.seq} className={line.stream === "info" ? "text-muted-foreground" : undefined}>
              {line.stepId && stepNames.get(line.stepId) && (
                <span className="text-muted-foreground">{stepNames.get(line.stepId)} </span>
              )}
              {line.text}
            </div>
          ))}
        </div>

        {status === "failed" && snapshot?.error && (
          <p className="text-sm text-destructive">{snapshot.error}</p>
        )}
        {lost && (
          <p className="text-sm text-muted-foreground">
            任务状态已丢失（可能已过期或服务已重启）。
          </p>
        )}
        {!lost && transientErrors > 0 && (
          <p className="text-xs text-muted-foreground">连接中断，正在重试…（{transientErrors}）</p>
        )}

        <DialogFooter>
          {status === "running" && !lost && (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              关闭后任务会继续在后台运行。
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
