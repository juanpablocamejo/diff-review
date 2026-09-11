/** @param {unknown} ms */
export function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const totalSec = Math.floor(n / 1000);
  if (totalSec < 1) return "<1 s";
  if (totalSec < 60) return `${totalSec} s`;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** @param {{ extractMs?: number, aiMs?: number, renderMs?: number } | null | undefined} timings */
export function formatTimings(timings) {
  if (!timings || typeof timings !== "object") return "";
  const parts = [];
  if (Number.isFinite(Number(timings.extractMs))) parts.push(`git ${formatDurationMs(timings.extractMs)}`);
  if (Number.isFinite(Number(timings.aiMs))) parts.push(`modelo ${formatDurationMs(timings.aiMs)}`);
  if (Number.isFinite(Number(timings.renderMs))) parts.push(`HTML ${formatDurationMs(timings.renderMs)}`);
  return parts.join(" · ");
}

/** @param {unknown} value */
export function normalizeMs(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
