// The agent: Claude with a handful of tools, run as a manual tool-use loop per incoming message.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { readBrand, writeBrand } from "./brand.js";
import { label, localToUtc, nowLocal, RULES, validateTarget, type Draft, type Target } from "./platforms.js";
import { shortId, type Store } from "./store.js";
import * as zernio from "./zernio.js";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Message = Anthropic.Beta.BetaMessageParam;

const client = new Anthropic({ apiKey: config.anthropicKey });
const MAX_STEPS = 10;
const IDLE_RESET_MS = 6 * 60 * 60_000; // a conversation untouched for 6 hours starts fresh

const limits = Object.entries(RULES).map(([p, r]) => `${p} ${r.maxChars}`).join(", ");

const SYSTEM = `You are postbot, a social media assistant the user talks to over Telegram. You turn what they tell you (and any photos or videos they send) into posts for their connected accounts, then publish through Zernio.

How you work:
- When the user wants something posted, call list_accounts if you don't know their accounts yet, then call create_draft with a caption tailored to each platform. Default to every connected account that can take the media unless the user names platforms.
- The user approves drafts with buttons under the preview. You cannot publish yourself. Never say something is posted or scheduled; say the draft is ready for their tap.
- To change a draft, call create_draft again with the full new version. It replaces the old preview.
- If the user gives a time ("Friday 9am", "tomorrow morning"), set schedule_at in their local time as YYYY-MM-DDTHH:mm. The current local time is given with each message. Otherwise leave it null.
- Ask a question only when you can't write a sensible post without the answer. Otherwise draft first and let them revise.
- Media arrives as [image m_xxxx] or [video m_xxxx] markers. Use those ids in media_ids. You can see images; for videos you only have the user's description.
- Write like a person, not a marketer: specific, concrete, no filler. Match each platform: short and punchy for X/Threads/Bluesky, a YouTube title for every YouTube target, hashtags only where they help (Instagram, TikTok) and never more than the brand voice allows.
- Caption limits (characters): ${limits}. YouTube needs exactly one video; Instagram, TikTok and Pinterest need media.
- When the user states a lasting preference about tone, hashtags, emojis or things to avoid, offer to save it, and call update_brand_voice once they agree.
- Replies are shown as plain Telegram text: no Markdown, keep them to a sentence or two. Don't repeat the captions in your reply; the preview shows them.`;

const tools: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "list_accounts",
    description: "List the social accounts connected in Zernio. Returns account_id, platform and handle for each.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "create_draft",
    description: "Show the user a draft post with approval buttons. Replaces any draft already on screen. Returns problems to fix if the draft is invalid.",
    input_schema: {
      type: "object",
      properties: {
        media_ids: { type: "array", items: { type: "string" }, description: "Ids of the user's media to attach, e.g. m_1a2b3c4d. Empty for text-only." },
        targets: {
          type: "array",
          description: "One entry per account to post to.",
          items: {
            type: "object",
            properties: {
              account_id: { type: "string" },
              caption: { type: "string", description: "The full caption for this platform." },
              title: { type: ["string", "null"], description: "Required for YouTube, optional for Pinterest and Reddit, null otherwise." },
            },
            required: ["account_id", "caption", "title"],
            additionalProperties: false,
          },
        },
        schedule_at: { type: ["string", "null"], description: "Local time YYYY-MM-DDTHH:mm to schedule for, or null to post on approval." },
      },
      required: ["media_ids", "targets", "schedule_at"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "recent_posts",
    description: "The last posts sent through this bot with their current status and live links.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "update_brand_voice",
    description: "Replace the brand voice file (Markdown) that guides every caption. Send the complete new file, keeping what still applies.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
    strict: true,
  },
];

export type AgentIO = { showDraft: (draft: Draft, previous: Draft | null) => Promise<void> };
type ToolResult = { text: string; isError?: boolean };

async function runTool(name: string, input: Record<string, unknown>, chatId: number, store: Store, io: AgentIO): Promise<ToolResult> {
  switch (name) {
    case "list_accounts": {
      const accounts = await zernio.listAccounts(true);
      if (!accounts.length) return { text: "No accounts are connected in Zernio. Tell the user to connect them at zernio.com.", isError: true };
      return { text: JSON.stringify(accounts.map((a) => ({ account_id: a._id, platform: a.platform, handle: a.username ?? a.displayName ?? "" }))) };
    }
    case "create_draft": {
      const { media_ids, targets, schedule_at } = input as {
        media_ids: string[]; targets: { account_id: string; caption: string; title: string | null }[]; schedule_at: string | null;
      };
      const accounts = await zernio.listAccounts();
      const media = store.getMedia(chatId, media_ids);
      const problems: string[] = [];
      const missing = media_ids.filter((id) => !media.some((m) => m.id === id));
      if (missing.length) problems.push(`Unknown media ids: ${missing.join(", ")}.`);
      if (!targets.length) problems.push("No targets.");
      if (schedule_at) {
        const when = localToUtc(schedule_at, config.timezone);
        if (!when) problems.push("schedule_at must look like 2026-10-30T09:00.");
        else if (when.getTime() < Date.now() + 2 * 60_000) problems.push("schedule_at is in the past. Use null to post on approval.");
      }
      const previous = store.pendingDraft(chatId);
      const draftTargets: Target[] = [];
      for (const t of targets) {
        const acct = accounts.find((a) => a._id === t.account_id);
        if (!acct) { problems.push(`Unknown account_id ${t.account_id}. Call list_accounts.`); continue; }
        problems.push(...validateTarget({ platform: acct.platform, caption: t.caption, title: t.title }, media));
        const wasOff = previous?.targets.some((p) => p.accountId === acct._id && !p.enabled);
        draftTargets.push({
          accountId: acct._id, platform: acct.platform, handle: acct.username ? `@${acct.username.replace(/^@/, "")}` : acct.displayName ?? "",
          caption: t.caption, title: t.title, enabled: !wasOff,
        });
      }
      if (problems.length) return { text: `Draft not shown. Fix and call create_draft again:\n- ${problems.join("\n- ")}`, isError: true };
      const draft: Draft = { id: shortId("d"), chatId, mediaIds: media_ids, targets: draftTargets, scheduleAt: schedule_at, status: "pending", previewMessageId: null };
      store.saveDraft(draft);
      await io.showDraft(draft, previous);
      return { text: `Draft ${draft.id} is on screen with Post / Schedule / Revise / Cancel buttons. Reply with one short line; don't repeat the captions.` };
    }
    case "recent_posts": {
      const posts = store.recentPosts(chatId);
      if (!posts.length) return { text: "Nothing has been posted through this bot yet." };
      const out = await Promise.all(posts.map(async (p) => {
        try {
          const zp = await zernio.getPost(p.id);
          return { summary: p.summary, status: zp.status, scheduledFor: zp.scheduledFor ?? null, platforms: zernio.results(zp) };
        } catch {
          return { summary: p.summary, status: p.status };
        }
      }));
      return { text: JSON.stringify(out) };
    }
    case "update_brand_voice": {
      writeBrand(String(input.content ?? ""));
      return { text: "Brand voice saved. It applies from the next message on." };
    }
  }
  return { text: `Unknown tool ${name}`, isError: true };
}

/** Context the model needs each turn that would break the prompt cache if it lived in the system prompt. */
function turnContext(chatId: number, store: Store) {
  const lines = [`[Now: ${nowLocal(config.timezone)} ${config.timezone}]`];
  const draft = store.pendingDraft(chatId);
  if (draft) {
    const state = draft.targets.map((t) => `${label(t.platform)} ${t.enabled ? "on" : "off"}`).join(", ");
    lines.push(`[Draft ${draft.id} on screen: ${state}${draft.scheduleAt ? `, scheduled ${draft.scheduleAt}` : ""}]`);
  }
  return lines.join("\n");
}

export async function runAgent(chatId: number, content: Block[], store: Store, io: AgentIO): Promise<string> {
  // History is append-only within a conversation (thinking blocks must be passed back unchanged), and resets
  // after a post goes out, on /new, or after a long idle gap.
  const messages: Message[] = store.getMessages(chatId, IDLE_RESET_MS);
  messages.push({ role: "user", content: [{ type: "text", text: turnContext(chatId, store) }, ...content] });
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM },
    { type: "text", text: `Brand voice (from BRAND.md):\n\n${readBrand()}`, cache_control: { type: "ephemeral" } },
  ];

  let reply = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client.beta.messages.create({
        model: config.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: config.effort },
        cache_control: { type: "ephemeral" },
        system,
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: res.content as Block[] });
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) reply = text;

      if (res.stop_reason === "refusal") return "I can't help with that one.";
      if (res.stop_reason !== "tool_use") break;

      const results: Block[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        let out: ToolResult;
        try {
          out = await runTool(block.name, block.input as Record<string, unknown>, chatId, store, io);
        } catch (err) {
          out = { text: `Tool failed: ${(err as Error).message}`, isError: true };
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    // Only save a history that ends on an assistant turn, so the next request is valid.
    if (messages.at(-1)?.role === "assistant") store.saveMessages(chatId, messages);
  }
  return reply || "Done.";
}
