// Draft preview message (HTML) and its buttons.
import { formatLocal, label, localToUtc, type Draft, type Media } from "./platforms.js";

const LIMIT = 4000; // Telegram caps messages at 4096 characters
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Button = { text: string; callback_data: string };

export function previewHeader(draft: Draft, media: Media[], tz: string) {
  const photos = media.filter((m) => m.kind === "image").length;
  const videos = media.length - photos;
  const parts = [photos && `${photos} photo${photos > 1 ? "s" : ""}`, videos && `${videos} video${videos > 1 ? "s" : ""}`].filter(Boolean);
  const when = draft.scheduleAt ? localToUtc(draft.scheduleAt, tz) : null;
  return [
    `<b>📝 Draft</b>${parts.length ? ` · ${parts.join(", ")}` : " · text only"}`,
    when ? `🗓 Scheduled for <b>${esc(formatLocal(when, tz))}</b>` : "",
  ].filter(Boolean).join("\n");
}

/** Message bodies to send in order; the last one carries the buttons. */
export function renderPreview(draft: Draft, media: Media[], tz: string): string[] {
  const sections = draft.targets.map((t) => {
    const title = t.title ? `\n<i>Title:</i> ${esc(t.title)}` : "";
    const off = t.enabled ? "" : " <i>(off)</i>";
    return `<b>${esc(label(t.platform))}</b> ${esc(t.handle)}${off}${title}\n${esc(t.caption)}`;
  });
  const chunks: string[] = [];
  let current = previewHeader(draft, media, tz);
  for (const s of sections) {
    const piece = s.length > LIMIT ? s.slice(0, LIMIT - 20) + "…" : s;
    if (current.length + piece.length + 2 > LIMIT) {
      chunks.push(current);
      current = piece;
    } else current += `\n\n${piece}`;
  }
  chunks.push(current);
  return chunks;
}

export function previewKeyboard(draft: Draft, tz: string): Button[][] {
  const toggles = draft.targets.map((t, i) => ({ text: `${t.enabled ? "✅" : "▫️"} ${label(t.platform)}`, callback_data: `t:${draft.id}:${i}` }));
  const rows: Button[][] = [];
  for (let i = 0; i < toggles.length; i += 3) rows.push(toggles.slice(i, i + 3));
  const when = draft.scheduleAt ? localToUtc(draft.scheduleAt, tz) : null;
  rows.push([
    { text: "🚀 Post now", callback_data: `p:${draft.id}` },
    when ? { text: `🗓 Schedule ${formatLocal(when, tz)}`, callback_data: `s:${draft.id}` } : { text: "🗓 Schedule…", callback_data: `w:${draft.id}` },
  ]);
  rows.push([
    { text: "✏️ Revise", callback_data: `r:${draft.id}` },
    { text: "🗑 Cancel", callback_data: `x:${draft.id}` },
  ]);
  return rows;
}
