const DEFAULT_DASHBOARD_BASE = "https://dashboard.render.com";

/**
 * Base URL for "open Render Dashboard" links (tasks / workflows UI).
 * Uses RENDER_DASHBOARD_TASKS_URL when set to a valid http(s) URL; otherwise the public dashboard origin.
 */
export function getRenderDashboardTasksUrl(): string {
  const raw = process.env.RENDER_DASHBOARD_TASKS_URL?.trim();
  if (!raw) return DEFAULT_DASHBOARD_BASE;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return DEFAULT_DASHBOARD_BASE;
    }
    return u.href.replace(/\/$/, "");
  } catch {
    return DEFAULT_DASHBOARD_BASE;
  }
}
