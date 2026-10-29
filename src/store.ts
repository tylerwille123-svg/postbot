// SQLite state: conversation history, uploaded media, drafts, and sent posts.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Draft, Media, MediaKind } from "./platforms.js";

type Message = Anthropic.Beta.BetaMessageParam;
export type SentPost = { id: string; chatId: number; summary: string; status: string; scheduledAt: number | null; notified: boolean; createdAt: number };

export const shortId = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (chat_id INTEGER PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
        filename TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        scheduled_at INTEGER, notified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    `);
  }

  // --- conversation -------------------------------------------------------
  getMessages(chatId: number, maxIdleMs: number): Message[] {
    const row = this.db.prepare("SELECT messages, updated_at FROM conversations WHERE chat_id = ?").get(chatId) as
      | { messages: string; updated_at: number } | undefined;
    if (!row || Date.now() - row.updated_at > maxIdleMs) return [];
    return JSON.parse(row.messages);
  }
  saveMessages(chatId: number, messages: Message[]) {
    this.db.prepare("INSERT OR REPLACE INTO conversations (chat_id, messages, updated_at) VALUES (?, ?, ?)")
      .run(chatId, JSON.stringify(messages), Date.now());
  }
  resetConversation(chatId: number) {
    this.db.prepare("DELETE FROM conversations WHERE chat_id = ?").run(chatId);
  }

  // --- media --------------------------------------------------------------
  addMedia(chatId: number, kind: MediaKind, url: string, filename: string): Media {
    const id = shortId("m_");
    this.db.prepare("INSERT INTO media (id, chat_id, kind, url, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, chatId, kind, url, filename, Date.now());
    return { id, kind, url, filename };
  }
  getMedia(chatId: number, ids: string[]): Media[] {
    const stmt = this.db.prepare("SELECT id, kind, url, filename FROM media WHERE chat_id = ? AND id = ?");
    return ids.map((id) => stmt.get(chatId, id) as Media | undefined).filter((m): m is Media => !!m);
  }

  // --- drafts -------------------------------------------------------------
  saveDraft(d: Draft) {
    this.db.prepare("INSERT OR REPLACE INTO drafts (id, chat_id, status, json, created_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM drafts WHERE id = ?), ?))")
      .run(d.id, d.chatId, d.status, JSON.stringify(d), d.id, Date.now());
  }
  getDraft(id: string): Draft | null {
    const row = this.db.prepare("SELECT json FROM drafts WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  pendingDraft(chatId: number): Draft | null {
    const row = this.db.prepare("SELECT json FROM drafts WHERE chat_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(chatId) as
      | { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  // --- sent posts ---------------------------------------------------------
  addPost(p: Omit<SentPost, "notified" | "createdAt">) {
    this.db.prepare("INSERT OR REPLACE INTO posts (id, chat_id, summary, status, scheduled_at, notified, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(p.id, p.chatId, p.summary, p.status, p.scheduledAt, Date.now());
  }
  getPost(id: string): SentPost | null {
    const row = this.db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toPost(row) : null;
  }
  updatePost(id: string, status: string, notified: boolean) {
    this.db.prepare("UPDATE posts SET status = ?, notified = ? WHERE id = ?").run(status, notified ? 1 : 0, id);
  }
  /** Posts we haven't reported back on yet and that should have gone out by now. */
  duePosts(now = Date.now()): SentPost[] {
    return (this.db.prepare("SELECT * FROM posts WHERE notified = 0 AND (scheduled_at IS NULL OR scheduled_at <= ?)").all(now) as Record<string, unknown>[]).map(toPost);
  }
  recentPosts(chatId: number, limit = 10): SentPost[] {
    return (this.db.prepare("SELECT * FROM posts WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?").all(chatId, limit) as Record<string, unknown>[]).map(toPost);
  }
}

const toPost = (r: Record<string, unknown>): SentPost => ({
  id: r.id as string, chatId: Number(r.chat_id), summary: r.summary as string, status: r.status as string,
  scheduledAt: r.scheduled_at == null ? null : Number(r.scheduled_at), notified: !!r.notified, createdAt: Number(r.created_at),
});
