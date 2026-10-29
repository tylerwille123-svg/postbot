// Platform rules, draft validation, and the Zernio request body. Everything here is pure so it can be unit tested.

export type MediaKind = "image" | "video";
export type Media = { id: string; kind: MediaKind; url: string; filename: string };
export type Account = { _id: string; platform: string; username?: string; displayName?: string; isActive?: boolean };

export type Target = { accountId: string; platform: string; handle: string; caption: string; title: string | null; enabled: boolean };
export type Draft = {
  id: string;
  chatId: number;
  mediaIds: string[];
  targets: Target[];
  scheduleAt: string | null; // local wall-clock time "YYYY-MM-DDTHH:mm" in config.timezone
  status: "pending" | "sent" | "cancelled" | "superseded";
  previewMessageId: number | null;
};

type Rule = {
  label: string;
  maxChars: number;
  needsMedia?: boolean;
  needsVideo?: boolean;
  maxImages?: number;
  maxTitle?: number;
};

// Caption limits are the platforms' own; unknown platforms fall back to DEFAULT_RULE.
export const RULES: Record<string, Rule> = {
  instagram: { label: "Instagram", maxChars: 2200, needsMedia: true, maxImages: 10 },
  facebook: { label: "Facebook", maxChars: 63206, maxImages: 10 },
  tiktok: { label: "TikTok", maxChars: 2200, needsMedia: true, maxImages: 35 },
  youtube: { label: "YouTube", maxChars: 5000, needsVideo: true, maxTitle: 100 },
  twitter: { label: "X", maxChars: 280, maxImages: 4 },
  linkedin: { label: "LinkedIn", maxChars: 3000, maxImages: 9 },
  threads: { label: "Threads", maxChars: 500, maxImages: 10 },
  bluesky: { label: "Bluesky", maxChars: 300, maxImages: 4 },
  pinterest: { label: "Pinterest", maxChars: 500, needsMedia: true, maxImages: 1, maxTitle: 100 },
  googlebusiness: { label: "Google Business", maxChars: 1500, maxImages: 1 },
  reddit: { label: "Reddit", maxChars: 40000, maxTitle: 300 },
};
const DEFAULT_RULE: Rule = { label: "", maxChars: 5000 };

export const rule = (platform: string): Rule => RULES[platform] ?? { ...DEFAULT_RULE, label: platform };
export const label = (platform: string) => rule(platform).label;

/** Problems that would make Zernio (or the platform) reject this target. Empty means it's fine. */
export function validateTarget(t: Pick<Target, "platform" | "caption" | "title">, media: Media[]): string[] {
  const r = rule(t.platform);
  const errs: string[] = [];
  const images = media.filter((m) => m.kind === "image").length;
  const videos = media.filter((m) => m.kind === "video").length;
  const len = [...t.caption].length;
  if (len > r.maxChars) errs.push(`${r.label} caption is ${len} characters; the limit is ${r.maxChars}.`);
  if (!t.caption.trim() && !media.length) errs.push(`${r.label} post has no caption and no media.`);
  if (r.needsMedia && !media.length) errs.push(`${r.label} needs a photo or video.`);
  if (r.needsVideo && (videos !== 1 || images > 0)) errs.push(`${r.label} needs exactly one video and no photos.`);
  if (r.maxImages !== undefined && images > r.maxImages) errs.push(`${r.label} allows at most ${r.maxImages} photo(s).`);
  if (videos > 1 && t.platform !== "instagram" && t.platform !== "facebook") errs.push(`${r.label} takes one video per post.`);
  if (r.maxTitle && t.title && [...t.title].length > r.maxTitle) errs.push(`${r.label} title is over ${r.maxTitle} characters.`);
  return errs;
}

export type PostSettings = { timezone: string; youtubeVisibility: string; tiktokPrivacy: string; tiktokCommercial: string };

/** The POST /v1/posts body for a draft. Each platform gets its own caption via customContent. */
export function buildPostBody(draft: Draft, media: Media[], s: PostSettings, publishNow: boolean) {
  const targets = draft.targets.filter((t) => t.enabled);
  return {
    content: targets[0]?.caption ?? "",
    mediaItems: media.map((m) => ({ type: m.kind, url: m.url })),
    ...(publishNow || !draft.scheduleAt ? { publishNow: true } : { scheduledFor: draft.scheduleAt, timezone: s.timezone }),
    platforms: targets.map((t) => ({
      platform: t.platform,
      accountId: t.accountId,
      customContent: t.caption,
      ...(t.platform === "youtube"
        ? { platformSpecificData: { title: (t.title || t.caption.split("\n")[0] || "Untitled").slice(0, 100), visibility: s.youtubeVisibility } }
        : {}),
      ...(t.platform === "pinterest" && t.title ? { platformSpecificData: { title: t.title.slice(0, 100) } } : {}),
      ...(t.platform === "tiktok"
        ? {
            platformSpecificData: {
              privacyLevel: s.tiktokPrivacy, allowComment: true, allowDuet: true, allowStitch: true,
              commercialContentType: s.tiktokCommercial, contentPreviewConfirmed: true, expressConsentGiven: true,
            },
          }
        : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Time: the model works in local wall-clock time; Zernio takes the same plus an IANA zone.
// ---------------------------------------------------------------------------
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function wallClock(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = (type: string) => Number(p.find((x) => x.type === type)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
}

/** "2026-10-30T09:00" in tz -> the UTC instant. Null when the string isn't in that shape. */
export function localToUtc(local: string, tz: string): Date | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes settle the offset, including across DST changes.
  let t = asUtc - (wallClock(new Date(asUtc), tz) - asUtc);
  t = asUtc - (wallClock(new Date(t), tz) - t);
  return new Date(t);
}

/** "Thu, Oct 29, 2:05 PM" in tz. */
export function formatLocal(date: Date, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** Current local time as "YYYY-MM-DDTHH:mm" plus weekday, for the model. */
export function nowLocal(tz: string, now = new Date()) {
  const iso = new Date(wallClock(now, tz)).toISOString().slice(0, 16);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
  return `${weekday} ${iso}`;
}
