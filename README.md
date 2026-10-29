# postbot by Wompel

Talk to a Telegram bot, send it a photo or a video, and it writes a caption for each of your social accounts. You approve the draft with a tap and it publishes through [Zernio](https://zernio.com), either right away or at a time you choose.

```
You:     [photo] new fall menu drops friday, post it to insta and tiktok
postbot: 📝 Draft · 1 photo
         Instagram @yourshop
         Pumpkin everything, starting Friday. …
         TikTok @yourshop
         POV: the fall menu finally dropped 🎃 …
         [✅ Instagram] [✅ TikTok]
         [🚀 Post now] [🗓 Schedule…]
         [✏️ Revise]   [🗑 Cancel]
You:     make tiktok shorter and schedule both for friday 9am
postbot: 📝 Draft · 1 photo · 🗓 Scheduled for Fri, Oct 30, 9:00 AM …
```

- **Chat in plain language.** Claude runs as a tool-using agent, so things like "punchier", "skip TikTok" or "same thing but for LinkedIn" just work.
- **Captions written per platform.** Each platform gets its own caption, within its character limit and media rules. YouTube gets a title.
- **Nothing posts without your tap.** Every draft comes with Post now / Schedule / Revise / Cancel buttons, plus a button per platform to turn it on or off.
- **Scheduling.** Say "Friday 9am" and the post is scheduled in your timezone. Zernio holds the schedule, so the bot doesn't need its own cron job.
- **Links back.** Once a post is live, the bot sends you the link for each platform, or the error if a platform failed.
- **Brand voice.** A `BRAND.md` file sets your tone, hashtag rules and words to avoid. You can edit it with `/voice`, or just tell the bot "never use emojis".
- **Voice notes** (optional). These are transcribed with OpenAI Whisper when `OPENAI_API_KEY` is set.
- **Private.** The bot is locked to your Telegram user ID.

## What you need

| | Where to get it |
|---|---|
| Telegram bot token | Message [@BotFather](https://t.me/BotFather), send `/newbot` |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) |
| Zernio API key | [zernio.com](https://zernio.com): create an account, connect your socials, then go to Settings → API keys |
| OpenAI API key (optional) | [platform.openai.com](https://platform.openai.com), only needed for voice notes |

Node 22.13 or newer (it uses the built-in `node:sqlite`).

## Run it locally

```bash
git clone https://github.com/tylerwille123-svg/postbot.git
cd postbot
npm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ZERNIO_API_KEY
npm run dev
```

Send your bot `/start`. It replies with your Telegram user ID. Put that in `.env` as `TELEGRAM_OWNER_ID` and restart.

The bot uses long polling, so you don't need a public URL or a webhook. It answers only while the process is running. To reach it from your phone around the clock, deploy it.

## Deploy (always on)

Any host that runs a Docker container and keeps a small disk works.

**Railway**
1. Fork this repo, then in Railway choose New Project → Deploy from GitHub repo.
2. Add the variables from `.env.example` under Variables.
3. Add a Volume mounted at `/data`. This keeps your drafts, history and `BRAND.md` across deploys.

**Fly.io, Render, or a VPS.** Run the Dockerfile with the same env vars and a persistent volume at `/data`:

```bash
docker build -t postbot .
docker run -d --restart unless-stopped --env-file .env -v postbot-data:/data postbot
```

Run exactly one instance. Telegram only allows one long-polling connection per bot token.

## Configuration

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | |
| `TELEGRAM_OWNER_ID` | required | The only Telegram user the bot will answer |
| `ANTHROPIC_API_KEY` | required | |
| `ZERNIO_API_KEY` | required | |
| `ZERNIO_PROFILE_ID` | all accounts | Limit posting to the accounts in one Zernio profile |
| `OPENAI_API_KEY` | none | Turns on voice notes |
| `MODEL` | `claude-sonnet-5-5` | Any Claude model ID |
| `EFFORT` | `medium` | `low` is cheaper and faster, `high` is more careful |
| `TIMEZONE` | `UTC` | IANA zone, e.g. `America/New_York`, used for scheduling |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and your `BRAND.md` |
| `YOUTUBE_VISIBILITY` | `public` | `public`, `unlisted` or `private` |
| `TIKTOK_PRIVACY` | `PUBLIC_TO_EVERYONE` | |
| `TIKTOK_COMMERCIAL_CONTENT` | `none` | `none`, `brand_organic` or `brand_content` (TikTok's disclosure setting) |

## Commands

- `/start`: what the bot does
- `/accounts`: your connected Zernio accounts
- `/voice`: show your brand voice. `/voice <text>` replaces it.
- `/new`: drop the current draft and conversation

## How it works

```
Telegram ──► grammY bot ──► Claude (tool use) ──► create_draft ──► preview + buttons
                 │                                                        │
                 └─ photos/videos ──► Zernio media upload        tap Post / Schedule
                                                                          │
                                                   Zernio POST /v1/posts ◄┘
                                                              │
                                    status poller (every 60s) ─► "✅ Live" + links
```

| File | |
|---|---|
| `src/agent.ts` | System prompt, tools (`list_accounts`, `create_draft`, `recent_posts`, `update_brand_voice`), tool-use loop |
| `src/bot.ts` | Owner lock, batching of albums, media upload, the buttons, status reports |
| `src/platforms.ts` | Per-platform caption limits and media rules, the Zernio request body, timezone math |
| `src/zernio.ts` | Zernio API client |
| `src/store.ts` | SQLite: conversation, media, drafts, sent posts |
| `src/preview.ts` | Draft preview text and keyboard |

The conversation resets after a post goes out or is cancelled, after `/new`, or after six hours without a message. That keeps each request small.

## Limits

- Telegram bots can download files up to 20 MB. For bigger videos, compress them, or send the file to Zernio directly.
- Pinterest boards and Reddit subreddits aren't set yet, so posts to those platforms may need those fields added in `buildPostBody`. PRs are welcome.
- One owner per deployment. To run it for several brands, deploy one bot per brand and give each a different `ZERNIO_PROFILE_ID`.

## Development

```bash
npm test         # vitest
npm run typecheck
```

## License

MIT © [Wompel](https://wompelproducts.ai)

---

**Want this run for you?** Wompel builds and runs AI social agents for businesses, from strategy and content to posting and weekly reports. [wompelproducts.ai](https://wompelproducts.ai)
