import { useEffect, useState } from "react";
import { apiPost } from "@/lib/api";
import type { PullSchedule, PullStrategy } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { formatTime } from "@/lib/format";

const INTERVAL_MIN = 5;
const INTERVAL_MAX = 1440;
const PRESETS = [15, 30, 60, 120];

const STRATEGY_OPTIONS: { value: PullStrategy; label: string; hint: string }[] = [
  { value: "ff-only", label: "仅快进（ff-only）", hint: "有本地改动或无法快进时跳过并记录，绝不覆盖。" },
  { value: "fetch-only", label: "仅抓取（fetch-only）", hint: "只更新远端引用，不改动工作区。" },
  { value: "reset-hard", label: "强制对齐（reset-hard）", hint: "丢弃本地改动对齐远端，谨慎使用。" },
];

function clampInterval(value: number): number {
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.floor(value)));
}

export function ScheduleCard({
  profile,
  schedule,
  lastScheduledAt,
  busy,
  onSaved,
  onPullAll,
}: {
  profile: string;
  schedule: PullSchedule;
  lastScheduledAt?: string;
  busy: boolean;
  onSaved: (next: PullSchedule) => void;
  onPullAll: () => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [intervalText, setIntervalText] = useState(String(schedule.intervalMinutes));
  const [strategy, setStrategy] = useState<PullStrategy>(schedule.strategy);
  const [notify, setNotify] = useState(schedule.notifyOnFailure);
  const [saving, setSaving] = useState(false);

  // Reset the form only when the persisted values change, so a background
  // reload (e.g. a job finishing) can't clobber in-progress edits.
  useEffect(() => {
    setEnabled(schedule.enabled);
    setIntervalText(String(schedule.intervalMinutes));
    setStrategy(schedule.strategy);
    setNotify(schedule.notifyOnFailure);
  }, [schedule.enabled, schedule.intervalMinutes, schedule.strategy, schedule.notifyOnFailure]);

  const intervalNumber = Number(intervalText);
  const intervalValid =
    Number.isInteger(intervalNumber) &&
    intervalNumber >= INTERVAL_MIN &&
    intervalNumber <= INTERVAL_MAX;
  const dirty =
    enabled !== schedule.enabled ||
    intervalNumber !== schedule.intervalMinutes ||
    strategy !== schedule.strategy ||
    notify !== schedule.notifyOnFailure;
  const disabled = busy || saving;

  async function save() {
    if (!intervalValid) {
      toast.error(`间隔需为 ${INTERVAL_MIN}–${INTERVAL_MAX} 之间的整数分钟`);
      return;
    }
    setSaving(true);
    try {
      const next = await apiPost<PullSchedule>(`/api/schedule?profile=${encodeURIComponent(profile)}`, {
        enabled,
        intervalMinutes: intervalNumber,
        strategy,
        notifyOnFailure: notify,
      });
      onSaved(next);
      toast.success("已保存定时拉取设置");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>定时拉取</CardTitle>
        <div className="flex items-center gap-2">
          <Label htmlFor="sched-enabled" className="text-xs text-muted-foreground">
            {enabled ? "已启用" : "已停用"}
          </Label>
          <Switch
            id="sched-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={disabled}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          由 supervisor 按间隔统一拉取项目列表里的所有仓库，profile 离线也会执行；有本地未提交改动时按所选策略跳过并记录，绝不覆盖。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>间隔（分钟）</Label>
            <div className="flex items-center gap-2">
              <Input
                className="h-9 w-24"
                inputMode="numeric"
                value={intervalText}
                onChange={(e) => setIntervalText(e.target.value.replace(/[^\d]/g, ""))}
                onBlur={() => {
                  const n = Number(intervalText);
                  if (intervalText.trim() && Number.isFinite(n)) {
                    setIntervalText(String(clampInterval(n)));
                  }
                }}
                disabled={disabled}
              />
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    disabled={disabled}
                    onClick={() => setIntervalText(String(m))}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              范围 {INTERVAL_MIN}–{INTERVAL_MAX} 分钟。
            </p>
          </div>
          <div className="space-y-2">
            <Label>策略</Label>
            <Select
              value={strategy}
              onValueChange={(v) => setStrategy(v as PullStrategy)}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sched-notify" checked={notify} onCheckedChange={setNotify} disabled={disabled} />
          <Label htmlFor="sched-notify">失败时给 owner 发飞书通知</Label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={disabled || !dirty} onClick={save}>
            保存
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">有未保存的改动</span>}
          <Button variant="outline" size="sm" disabled={disabled} onClick={onPullAll}>
            立即拉取全部
          </Button>
          <span className="text-xs text-muted-foreground">
            上次定时拉取：{lastScheduledAt ? formatTime(lastScheduledAt) : "—"}
          </span>
        </div>
        {!enabled && (
          <p className="text-xs text-muted-foreground">当前已停用，不会自动拉取；开启并保存后生效。</p>
        )}
      </CardContent>
    </Card>
  );
}
