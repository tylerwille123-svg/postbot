// Voice notes -> text with OpenAI Whisper. Only used when OPENAI_API_KEY is set.
import { config } from "./config.js";

export const canTranscribe = () => !!config.openaiKey;

export async function transcribe(bytes: Uint8Array<ArrayBuffer>, filename: string): Promise<string> {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([bytes]), filename);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Transcription failed: ${data.error?.message ?? res.status}`);
  return (data.text ?? "").trim();
}
