import path from "node:path";

const env = (k: string, fallback = "") => process.env[k]?.trim() || fallback;

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  ownerId: Number(env("TELEGRAM_OWNER_ID", "0")),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  zernioKey: env("ZERNIO_API_KEY"),
  zernioProfileId: env("ZERNIO_PROFILE_ID"),
  openaiKey: env("OPENAI_API_KEY"),
  model: env("MODEL", "claude-sonnet-5-5"),
  effort: env("EFFORT", "medium") as "low" | "medium" | "high",
  timezone: env("TIMEZONE", "UTC"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  youtubeVisibility: env("YOUTUBE_VISIBILITY", "public"),
  tiktokPrivacy: env("TIKTOK_PRIVACY", "PUBLIC_TO_EVERYONE"),
  tiktokCommercial: env("TIKTOK_COMMERCIAL_CONTENT", "none"),
};

export function missingConfig() {
  const required = { TELEGRAM_BOT_TOKEN: config.telegramToken, ANTHROPIC_API_KEY: config.anthropicKey, ZERNIO_API_KEY: config.zernioKey };
  return Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
}
