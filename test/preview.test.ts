import { describe, expect, it } from "vitest";
import { previewKeyboard, renderPreview } from "../src/preview.js";
import type { Draft } from "../src/platforms.js";

const draft = (captions: string[], scheduleAt: string | null = null): Draft => ({
  id: "dabcdef12", chatId: 1, mediaIds: [], scheduleAt, status: "pending", previewMessageId: null,
  targets: captions.map((caption, i) => ({
    accountId: `a${i}`, platform: ["facebook", "linkedin", "threads"][i % 3], handle: "@shop", caption, title: null, enabled: true,
  })),
});

describe("renderPreview", () => {
  it("escapes HTML in captions", () => {
    const [html] = renderPreview(draft(["Tacos <3 & more"]), [], "UTC");
    expect(html).toContain("Tacos &lt;3 &amp; more");
  });
  it("splits long drafts under Telegram's message limit", () => {
    const chunks = renderPreview(draft(["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)]), [], "UTC");
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });
  it("shows the scheduled time", () => {
    const [html] = renderPreview(draft(["hi"], "2026-11-06T09:00"), [], "America/New_York");
    expect(html).toMatch(/Scheduled for <b>Fri, Nov 6, 9:00 AM<\/b>/);
  });
});

describe("previewKeyboard", () => {
  it("keeps callback data within Telegram's 64-byte limit", () => {
    const rows = previewKeyboard(draft(Array(9).fill("x"), "2026-11-06T09:00"), "UTC");
    for (const b of rows.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
  it("offers a schedule button with the time only when one is set", () => {
    expect(previewKeyboard(draft(["x"]), "UTC").flat().some((b) => b.callback_data.startsWith("w:"))).toBe(true);
    expect(previewKeyboard(draft(["x"], "2026-11-06T09:00"), "UTC").flat().some((b) => b.callback_data.startsWith("s:"))).toBe(true);
  });
});
