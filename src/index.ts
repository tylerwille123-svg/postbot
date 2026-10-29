import path from "node:path";
import { config, missingConfig } from "./config.js";
import { createBot, startStatusPoller } from "./bot.js";
import { Store } from "./store.js";

const missing = missingConfig();
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}. See .env.example.`);
  process.exit(1);
}

const store = new Store(path.join(config.dataDir, "postbot.db"));
const bot = createBot(store);
const poller = startStatusPoller(bot, store);

const stop = () => { clearInterval(poller); void bot.stop(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await bot.api.setMyCommands([
  { command: "start", description: "What I do" },
  { command: "accounts", description: "Connected accounts" },
  { command: "voice", description: "View or replace your brand voice" },
  { command: "new", description: "Start over" },
]);
console.log(`postbot running (model ${config.model}, timezone ${config.timezone})${config.ownerId ? "" : " - send /start to get your TELEGRAM_OWNER_ID"}`);
await bot.start({ drop_pending_updates: false });
