// Telegram side: owner lock, message batching (albums arrive as several updates), media upload, buttons, status updates.
import { Bot, type Context } from "grammy";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { readBrand, writeBrand } from "./brand.js";
import { buildPostBody, formatLocal, label, localToUtc, type Draft, type MediaKind } from "./platforms.js";
import { esc, previewKeyboard, renderPreview } from "./preview.js";
import type { Store } from "./store.js";
import { canTranscribe, transcribe } from "./transcribe.js";
import * as zernio from "./zernio.js";

type Block = Anthropic.Beta.BetaContentBlockParam;

const BATCH_MS = 1500;
const MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram's Bot API won't hand bots files larger than this
const MAX_IMAGE_FOR_MODEL = 5 * 1024 * 1024;

const INTRO = `👋 <b>postbot by Wompel</b>

Send me what you want to post, with photos or videos if you have them. I'll write a caption for each of your connected accounts and show you a preview. Nothing goes out until you tap <b>Post now</b> or <b>Schedule</b>.

Try: <i>"Post this to Instagram and TikTok, something about our new fall menu"</i>

/accounts – connected accounts
/voice – view or replace your brand voice
/new – start over

Want this run for you? wompelproducts.com`;

export function createBot(store: Store) {
  const bot = new Bot(config.telegramToken);

  // ---- owner lock -------------------------------------------------------
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (!from) return;
    if (!config.ownerId) {
      if (ctx.message) await ctx.reply(`Your Telegram user ID is ${from}. Set TELEGRAM_OWNER_ID=${from} and restart the bot.`);
      return;
    }
    if (from !== config.ownerId) {
      if (ctx.message?.text === "/start") await ctx.reply("This is a private bot.");
      return;
    }
    await next();
  });

  // ---- commands ---------------------------------------------------------
  bot.command(["start", "help"], (ctx) => ctx.reply(INTRO, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }));

  bot.command("new", async (ctx) => {
    const draft = store.pendingDraft(ctx.chat.id);
    if (draft) await retire(ctx, draft, "cancelled");
    store.resetConversation(ctx.chat.id);
    await ctx.reply("Fresh start. What are we posting?");
  });

  bot.command("accounts", async (ctx) => {
    const accounts = await zernio.listAccounts(true);
    if (!accounts.length) return ctx.reply("No accounts connected yet. Connect them in your Zernio dashboard (zernio.com), then try again.");
    await ctx.reply(accounts.map((a) => `• ${label(a.platform)}: ${a.username ? `@${a.username.replace(/^@/, "")}` : a.displayName ?? a._id}`).join("\n"));
  });

  bot.command("voice", async (ctx) => {
    const text = ctx.match?.trim();
    if (text) {
      writeBrand(text);
      return ctx.reply("Brand voice replaced.");
    }
    await ctx.reply(`<b>Your brand voice</b> (send /voice followed by new text to replace it, or just tell me what to change)\n\n<pre>${esc(readBrand().slice(0, 3500))}</pre>`, { parse_mode: "HTML" });
  });

  // ---- messages: collect for a moment, then run the agent once ------------
  const pending = new Map<number, { parts: Promise<Block[]>[]; timer: NodeJS.Timeout }>();
  const queues = new Map<number, Promise<void>>();

  function enqueue(ctx: Context, part: Promise<Block[]>) {
    const chatId = ctx.chat!.id;
    const batch = pending.get(chatId) ?? { parts: [], timer: undefined as unknown as NodeJS.Timeout };
    clearTimeout(batch.timer);
    batch.parts.push(part);
    batch.timer = setTimeout(() => {
      pending.delete(chatId);
      const prev = queues.get(chatId) ?? Promise.resolve();
      const run = prev.then(() => handle(ctx, batch.parts)).catch((err) => console.error("agent run failed", err));
      queues.set(chatId, run);
    }, BATCH_MS);
    pending.set(chatId, batch);
  }

  async function handle(ctx: Context, parts: Promise<Block[]>[]) {
    const chatId = ctx.chat!.id;
    const settled = await Promise.allSettled(parts);
    const content = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    for (const s of settled) if (s.status === "rejected") await ctx.reply(`⚠️ ${(s.reason as Error).message}`);
    if (!content.length) return;
    const typing = setInterval(() => ctx.api.sendChatAction(chatId, "typing").catch(() => {}), 4500);
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    try {
      const reply = await runAgent(chatId, content, store, { showDraft: (d, prev) => showDraft(ctx, d, prev) });
      await ctx.reply(reply.slice(0, 4000));
    } catch (err) {
      console.error(err);
      await ctx.reply(`⚠️ Something went wrong talking to Claude: ${(err as Error).message}`);
    } finally {
      clearInterval(typing);
    }
  }

  async function download(ctx: Context, size?: number) {
    if (size && size > MAX_DOWNLOAD) throw new Error("That file is over Telegram's 20 MB bot limit. Send a smaller or compressed version.");
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram wouldn't hand over that file.");
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Couldn't download the file from Telegram (${res.status}).`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: file.file_path.split("/").pop() ?? "file" };
  }

  async function mediaPart(ctx: Context, kind: MediaKind, mime: string, size?: number, caption?: string): Promise<Block[]> {
    const { bytes, name } = await download(ctx, size);
    const url = await zernio.uploadMedia(bytes, name, mime);
    const media = store.addMedia(ctx.chat!.id, kind, url, name);
    const blocks: Block[] = [{ type: "text", text: `[${kind} ${media.id}]` }];
    if (kind === "image" && bytes.byteLength <= MAX_IMAGE_FOR_MODEL && /^image\/(jpeg|png|gif|webp)$/.test(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: Buffer.from(bytes).toString("base64") } });
    }
    if (caption) blocks.push({ type: "text", text: caption });
    return blocks;
  }

  bot.on("message:text", (ctx) => enqueue(ctx, Promise.resolve([{ type: "text", text: ctx.message.text }])));

  bot.on("message:photo", (ctx) => {
    const photo = ctx.message.photo.at(-1)!;
    enqueue(ctx, mediaPart(ctx, "image", "image/jpeg", photo.file_size, ctx.message.caption));
  });

  bot.on("message:video", (ctx) => {
    const v = ctx.message.video;
    enqueue(ctx, mediaPart(ctx, "video", v.mime_type ?? "video/mp4", v.file_size, ctx.message.caption));
  });

  bot.on("message:document", (ctx) => {
    const d = ctx.message.document;
    const mime = d.mime_type ?? "";
    const kind: MediaKind | null = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : null;
    if (!kind) return void ctx.reply("I can only post photos and videos.");
    enqueue(ctx, mediaPart(ctx, kind, mime, d.file_size, ctx.message.caption));
  });

  bot.on(["message:voice", "message:audio"], (ctx) => {
    if (!canTranscribe()) return void ctx.reply("Voice notes need OPENAI_API_KEY set on the bot. Text works in the meantime.");
    const file = ctx.message.voice ?? ctx.message.audio!;
    enqueue(ctx, (async () => {
      const { bytes, name } = await download(ctx, file.file_size);
      const text = await transcribe(bytes, name.replace(/\.oga$/, ".ogg"));
      if (!text) throw new Error("I couldn't make out that voice note.");
      await ctx.reply(`🎙 “${text}”`);
      return [{ type: "text", text } as Block];
    })());
  });

  // ---- draft preview + buttons ----------------------------------------
  async function showDraft(ctx: Context, draft: Draft, previous: Draft | null) {
    if (previous) await retire(ctx, previous, "superseded");
    const chatId = ctx.chat!.id;
    const media = store.getMedia(chatId, draft.mediaIds);
    const chunks = renderPreview(draft, media, config.timezone);
    let last = 0;
    for (const [i, html] of chunks.entries()) {
      const isLast = i === chunks.length - 1;
      const msg = await ctx.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(isLast ? { reply_markup: { inline_keyboard: previewKeyboard(draft, config.timezone) } } : {}),
      });
      last = msg.message_id;
    }
    store.saveDraft({ ...draft, previewMessageId: last });
  }

  /** Mark a draft done and strip the buttons off its preview. */
  async function retire(ctx: Context, draft: Draft, status: Draft["status"], note?: string) {
    store.saveDraft({ ...draft, status });
    if (draft.previewMessageId) {
      await ctx.api.editMessageReplyMarkup(draft.chatId, draft.previewMessageId, { reply_markup: { inline_keyboard: note ? [[{ text: note, callback_data: "noop" }]] : [] } }).catch(() => {});
    }
  }

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery(/^([tpswrx]):(d[0-9a-f]{8})(?::(\d+))?$/, async (ctx) => {
    const [, action, id, idx] = ctx.match;
    const draft = store.getDraft(id);
    if (!draft || draft.status !== "pending" || draft.chatId !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({ text: "That draft isn't active anymore." });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }

    if (action === "t") {
      const t = draft.targets[Number(idx)];
      if (t) t.enabled = !t.enabled;
      store.saveDraft(draft);
      await ctx.answerCallbackQuery({ text: t ? `${label(t.platform)} ${t.enabled ? "on" : "off"}` : "" });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: previewKeyboard(draft, config.timezone) } }).catch(() => {});
      return;
    }
    if (action === "r") {
      await ctx.answerCallbackQuery();
      return void ctx.reply("What should I change?");
    }
    if (action === "w") {
      await ctx.answerCallbackQuery();
      return void ctx.reply("When should it go out? e.g. “Friday 9am” or “tomorrow at noon”.");
    }
    if (action === "x") {
      await retire(ctx, draft, "cancelled", "🗑 Cancelled");
      store.resetConversation(draft.chatId);
      return void ctx.answerCallbackQuery({ text: "Cancelled" });
    }

    // p = post now, s = schedule
    const enabled = draft.targets.filter((t) => t.enabled);
    if (!enabled.length) return void ctx.answerCallbackQuery({ text: "Turn on at least one platform first." });
    const publishNow = action === "p";
    const when = !publishNow && draft.scheduleAt ? localToUtc(draft.scheduleAt, config.timezone) : null;
    if (!publishNow && (!when || when.getTime() < Date.now() + 60_000)) {
      return void ctx.answerCallbackQuery({ text: "That time has passed. Tell me a new one or tap Post now." });
    }
    await ctx.answerCallbackQuery({ text: publishNow ? "Posting…" : "Scheduling…" });
    // Claim the draft before calling Zernio so a double tap can't send it twice.
    await retire(ctx, draft, "sent", publishNow ? "⏳ Posting…" : "⏳ Scheduling…");
    const media = store.getMedia(draft.chatId, draft.mediaIds);
    const body = buildPostBody(draft, media, {
      timezone: config.timezone, youtubeVisibility: config.youtubeVisibility, tiktokPrivacy: config.tiktokPrivacy, tiktokCommercial: config.tiktokCommercial,
    }, publishNow);
    const platforms = enabled.map((t) => label(t.platform)).join(", ");
    try {
      const { post } = await zernio.createPost(body, draft.id);
      const summary = `${platforms}: ${enabled[0].caption.slice(0, 60)}${enabled[0].caption.length > 60 ? "…" : ""}`;
      store.addPost({ id: post._id, chatId: draft.chatId, summary, status: post.status, scheduledAt: when ? when.getTime() : null });
      store.resetConversation(draft.chatId);
      await retire(ctx, draft, "sent", publishNow ? "🚀 Sent" : `🗓 Scheduled ${formatLocal(when!, config.timezone)}`);
      if (zernio.SETTLED.has(post.status)) {
        await reportPost(bot, store, post._id);
      } else {
        await ctx.reply(publishNow ? `Sending to ${platforms}. I'll send the links once it's live.` : `Scheduled for ${formatLocal(when!, config.timezone)} on ${platforms}. I'll send the links once it's live.`);
      }
    } catch (err) {
      store.saveDraft({ ...draft, status: "pending" });
      await ctx.api.editMessageReplyMarkup(draft.chatId, draft.previewMessageId!, { reply_markup: { inline_keyboard: previewKeyboard(draft, config.timezone) } }).catch(() => {});
      await ctx.reply(`⚠️ Zernio didn't accept it: ${(err as Error).message}`);
    }
  });

  bot.catch((err) => console.error("bot error", err.error));
  return bot;
}

/** Tell the owner how a post went, with links. Returns true once there's nothing left to wait for. */
export async function reportPost(bot: Bot, store: Store, postId: string): Promise<boolean> {
  const post = store.getPost(postId);
  const zp = await zernio.getPost(postId);
  if (!zernio.SETTLED.has(zp.status)) {
    store.updatePost(postId, zp.status, false);
    return false;
  }
  const lines = zernio.results(zp).map((r) =>
    r.status === "published"
      ? `✅ ${esc(label(r.platform))}${r.url ? `: <a href="${esc(r.url)}">view post</a>` : ""}`
      : `❌ ${esc(label(r.platform))}: ${esc(r.error ?? r.status ?? "failed")}`,
  );
  const head = zp.status === "published" ? "Live" : zp.status === "partial" ? "Partly posted" : zp.status === "cancelled" ? "Cancelled" : "Failed";
  await bot.api.sendMessage(post?.chatId ?? config.ownerId, `<b>${head}</b>${post ? ` · ${esc(post.summary)}` : ""}\n${lines.join("\n")}`, {
    parse_mode: "HTML", link_preview_options: { is_disabled: true },
  });
  store.updatePost(postId, zp.status, true);
  return true;
}

/** Every minute, check posts that should be out by now and report the ones that settled. */
export function startStatusPoller(bot: Bot, store: Store) {
  const tick = async () => {
    for (const p of store.duePosts()) {
      // Give up after a day so a stuck post doesn't get polled forever.
      if (Date.now() - (p.scheduledAt ?? p.createdAt) > 24 * 60 * 60_000) { store.updatePost(p.id, p.status, true); continue; }
      await reportPost(bot, store, p.id).catch((err) => console.error("status check failed", p.id, err.message));
    }
  };
  return setInterval(tick, 60_000);
}
