import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import type { Draft } from "../src/platforms.js";

describe("Store", () => {
  it("round-trips conversations and expires idle ones", () => {
    const s = new Store(":memory:");
    s.saveMessages(1, [{ role: "user", content: "hi" }]);
    expect(s.getMessages(1, 60_000)).toHaveLength(1);
    expect(s.getMessages(1, -1)).toEqual([]);
    s.resetConversation(1);
    expect(s.getMessages(1, 60_000)).toEqual([]);
  });
  it("only returns media from the same chat", () => {
    const s = new Store(":memory:");
    const m = s.addMedia(1, "image", "https://x/a.jpg", "a.jpg");
    expect(s.getMedia(1, [m.id])).toHaveLength(1);
    expect(s.getMedia(2, [m.id])).toHaveLength(0);
  });
  it("tracks the pending draft", () => {
    const s = new Store(":memory:");
    const d: Draft = { id: "d00000001", chatId: 1, mediaIds: [], targets: [], scheduleAt: null, status: "pending", previewMessageId: null };
    s.saveDraft(d);
    expect(s.pendingDraft(1)?.id).toBe("d00000001");
    s.saveDraft({ ...d, status: "sent" });
    expect(s.pendingDraft(1)).toBeNull();
  });
  it("lists posts that are due for a status check", () => {
    const s = new Store(":memory:");
    s.addPost({ id: "p1", chatId: 1, summary: "now", status: "publishing", scheduledAt: null });
    s.addPost({ id: "p2", chatId: 1, summary: "later", status: "scheduled", scheduledAt: Date.now() + 3_600_000 });
    expect(s.duePosts().map((p) => p.id)).toEqual(["p1"]);
    s.updatePost("p1", "published", true);
    expect(s.duePosts()).toEqual([]);
  });
});
