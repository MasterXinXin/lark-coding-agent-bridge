import type { PullRecord, PullResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTime } from "@/lib/format";

const RESULT_META: Record<PullResult, { label: string; variant: "success" | "secondary" | "destructive" }> = {
  updated: { label: "已更新", variant: "success" },
  "up-to-date": { label: "已最新", variant: "secondary" },
  skipped: { label: "已跳过", variant: "secondary" },
  failed: { label: "失败", variant: "destructive" },
};

export function PullHistoryCard({
  records,
  busy,
  onRefresh,
}: {
  records: PullRecord[];
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>拉取记录</CardTitle>
        <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
          刷新
        </Button>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无记录。点「立即拉取全部」或开启定时任务后会出现。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">时间</TableHead>
                <TableHead className="whitespace-nowrap">项目</TableHead>
                <TableHead className="whitespace-nowrap">分支</TableHead>
                <TableHead className="whitespace-nowrap">结果</TableHead>
                <TableHead className="whitespace-nowrap">触发</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r, i) => {
                const meta = RESULT_META[r.result] ?? { label: r.result, variant: "secondary" as const };
                return (
                  <TableRow key={`${r.ts}-${r.projectId}-${i}`}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatTime(r.ts)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{r.name}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{r.branch}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={meta.variant} className="whitespace-nowrap">
                        {meta.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {r.trigger === "schedule" ? "定时" : "手动"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="block max-w-[260px] truncate" title={r.detail}>
                        {r.detail || "—"}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
