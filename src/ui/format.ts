// Time formats for HUDs and result cards.

/** m:ss (whole seconds, rounded up while counting down). */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** m:ss (whole seconds, rounded down: an elapsed clock). */
export function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** m:ss.t for results. */
export function fmtTime(seconds: number): string {
  const t = Math.round(Math.max(0, seconds) * 10) / 10; // round first: 59.96 → 1:00.0, not 0:60.0
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
