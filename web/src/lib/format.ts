/** Local time for an ISO timestamp; "—" when missing/invalid. */
export function formatTime(ts?: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
