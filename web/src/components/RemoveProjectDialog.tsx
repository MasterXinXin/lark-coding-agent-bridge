import type { ProjectView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RemoveProjectDialog({
  open,
  onOpenChange,
  project,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  project: ProjectView | null;
  busy: boolean;
  onConfirm: (deleteDir: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>移除项目</DialogTitle>
          <DialogDescription>
            从项目列表移除 <span className="font-medium">{project?.name}</span>。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
            {project?.absolutePath ?? "—"}
          </div>
          {project && !project.exists && (
            <p className="text-sm text-destructive">目录不存在或不是 git 仓库</p>
          )}
          {project && project.status.dirty && (
            <p className="text-sm text-destructive">该目录有未提交的本地改动，删除后无法恢复</p>
          )}
          <p className="text-xs text-muted-foreground">
            「移除并删除目录」会递归删除上面的本地目录，且无法恢复。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onConfirm(false)}>
            仅移除记录
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => onConfirm(true)}>
            移除并删除目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
