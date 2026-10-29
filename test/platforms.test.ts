import { describe, expect, it } from "vitest";
import { buildPostBody, localToUtc, nowLocal, validateTarget, type Draft, type Media } from "../src/platforms.js";

const img: Media = { id: "m_1", kind: "image", url: "https://media.example/a.jpg", filename: "a.jpg" };
const vid: Media = { id: "m_2", kind: "video", url: "https://media.example/b.mp4", filename: "b.mp4" };
const settings = { timezone: "America/New_York", youtubeVisibility: "public", tiktokPrivacy: "PUBLIC_TO_EVERYONE", tiktokCommercial: "none" };

describe("validateTarget", () => {
  it("accepts a normal Instagram photo post", () => {
    expect(validateTarget({ platform: "instagram", caption: "Fall menu is here", title: null }, [img])).toEqual([]);
  });
  it("flags captions over the platform limit", () => {
    const errs = validateTarget({ platform: "twitter", caption: "x".repeat(281), title: null }, []);
    expect(errs.join()).toMatch(/281 characters; the limit is 280/);
  });
  it("counts emoji as one character", () => {
    expect(validateTarget({ platform: "twitter", caption: "🎃".repeat(280), title: null }, [])).toEqual([]);
  });
  it("requires media on Instagram and a single video on YouTube", () => {
    expect(validateTarget({ platform: "instagram", caption: "hi", title: null }, []).join()).toMatch(/needs a photo or video/);
    expect(validateTarget({ platform: "youtube", caption: "hi", title: "t" }, [img]).join()).toMatch(/exactly one video/);
    expect(validateTarget({ platform: "youtube", caption: "hi", title: "t" }, [vid])).toEqual([]);
  });
  it("caps photo counts", () => {
    expect(validateTarget({ platform: "twitter", caption: "hi", title: null }, Array(5).fill(img)).join()).toMatch(/at most 4/);
  });
  it("lets unknown platforms through with a generous limit", () => {
    expect(validateTarget({ platform: "mastodon", caption: "hi", title: null }, [])).toEqual([]);
  });
});

describe("buildPostBody", () => {
  const draft: Draft = {
    id: "d12345678", chatId: 1, mediaIds: ["m_2"], scheduleAt: "2026-11-06T09:00", status: "pending", previewMessageId: null,
    targets: [
      { accountId: "a1", platform: "tiktok", handle: "@x", caption: "tt caption", title: null, enabled: true },
      { accountId: "a2", platform: "youtube", handle: "@x", caption: "yt description", title: "My video", enabled: true },
      { accountId: "a3", platform: "instagram", handle: "@x", caption: "ig caption", title: null, enabled: false },
    ],
  };

  it("schedules in local time with the timezone and skips disabled targets", () => {
    const body = buildPostBody(draft, [vid], settings, false);
    expect(body).toMatchObject({ scheduledFor: "2026-11-06T09:00", timezone: "America/New_York" });
    expect(body).not.toHaveProperty("publishNow");
    expect(body.platforms.map((p) => p.accountId)).toEqual(["a1", "a2"]);
    expect(body.mediaItems).toEqual([{ type: "video", url: vid.url }]);
  });
  it("sends each platform its own caption plus the required platform settings", () => {
    const [tiktok, youtube] = buildPostBody(draft, [vid], settings, true).platforms;
    expect(tiktok.customContent).toBe("tt caption");
    expect(tiktok.platformSpecificData).toMatchObject({ privacyLevel: "PUBLIC_TO_EVERYONE", commercialContentType: "none", expressConsentGiven: true });
    expect(youtube.platformSpecificData).toEqual({ title: "My video", visibility: "public" });
  });
  it("publishes now when asked, even if a time was set", () => {
    const body = buildPostBody(draft, [vid], settings, true);
    expect(body).toMatchObject({ publishNow: true });
    expect(body).not.toHaveProperty("scheduledFor");
  });
});

describe("time helpers", () => {
  it("converts local wall-clock time to UTC across DST", () => {
    expect(localToUtc("2026-07-01T09:00", "America/New_York")?.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(localToUtc("2026-12-01T09:00", "America/New_York")?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(localToUtc("2026-11-01T12:00", "America/New_York")?.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
  it("rejects malformed times", () => {
    expect(localToUtc("Friday 9am", "UTC")).toBeNull();
  });
  it("describes now in the configured zone", () => {
    expect(nowLocal("America/New_York", new Date("2026-10-29T18:05:00Z"))).toBe("Thursday 2026-10-29T14:05");
  });
});
