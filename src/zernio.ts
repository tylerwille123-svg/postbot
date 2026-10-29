// Zernio REST client: accounts, media upload, posts. Docs: https://docs.zernio.com
import { config } from "./config.js";
import type { Account } from "./platforms.js";

const BASE = "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(public status: number, public body: unknown) {
    const msg = (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message;
    super(`Zernio ${status}${msg ? `: ${msg}` : ""}`);
  }
}

async function call<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.zernioKey}`,
      "Content-Type": "application/json",
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ZernioError(res.status, data);
  return { status: res.status, data: data as T };
}

let cache: { at: number; accounts: Account[] } | null = null;

/** Connected accounts (in ZERNIO_PROFILE_ID if set), cached for 5 minutes. */
export async function listAccounts(fresh = false): Promise<Account[]> {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.accounts;
  const q = config.zernioProfileId ? `?${new URLSearchParams({ profileId: config.zernioProfileId })}` : "";
  const { data } = await call<{ accounts: Account[] }>(`/accounts${q}`);
  const accounts = (data.accounts ?? []).filter((a) => a.isActive !== false);
  cache = { at: Date.now(), accounts };
  return accounts;
}

/** Presign, then PUT the bytes straight to storage. Returns the public URL posts reference. */
export async function uploadMedia(bytes: Uint8Array<ArrayBuffer>, filename: string, contentType: string): Promise<string> {
  const { data } = await call<{ uploadUrl: string; publicUrl: string }>("/media/presign", {
    method: "POST",
    body: JSON.stringify({ filename, contentType, size: bytes.byteLength }),
  });
  const put = await fetch(data.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!put.ok) throw new Error(`Media upload failed (${put.status})`);
  return data.publicUrl;
}

export type PlatformResult = { platform: string; status?: string; url?: string; error?: string | null };
export type ZernioPost = { _id: string; status: string; scheduledFor?: string; platforms?: { platform: string; status?: string; platformPostUrl?: string; errorMessage?: string }[] };

export const results = (post: ZernioPost): PlatformResult[] =>
  (post.platforms ?? []).map((p) => ({ platform: p.platform, status: p.status, url: p.platformPostUrl, error: p.errorMessage ?? null }));

/** Zernio answers 201 when everything went through and 207 when some platforms failed. */
export async function createPost(body: unknown, idempotencyKey: string) {
  const { status, data } = await call<{ post: ZernioPost }>("/posts", { method: "POST", body: JSON.stringify(body), idempotencyKey });
  return { partial: status === 207, post: data.post };
}

export async function getPost(id: string) {
  const { data } = await call<{ post?: ZernioPost } & ZernioPost>(`/posts/${id}`);
  return data.post ?? data;
}

export const SETTLED = new Set(["published", "partial", "failed", "cancelled"]);
