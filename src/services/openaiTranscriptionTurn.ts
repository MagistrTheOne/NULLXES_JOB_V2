import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";

export type TranscribeTurnOptions = {
  pcm16: Buffer;
  sampleRateHz: number;
  language?: string;
  prompt?: string;
  model?: string;
  signal?: AbortSignal;
};

/** PCM16 LE mono → minimal WAV for OpenAI transcriptions multipart upload. */
export function pcm16LeMonoToWav(pcm16: Buffer, sampleRateHz: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm16.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm16]);
}

/**
 * OpenAI Speech-to-text — one bounded turn per request.
 * @see https://developers.openai.com/api/docs/guides/speech-to-text
 */
export async function transcribePcm16Turn(options: TranscribeTurnOptions): Promise<{
  text: string;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const pcm = options.pcm16;
  if (pcm.length < 4) {
    return { text: "", durationMs: Date.now() - startedAt };
  }

  const sampleRateHz = options.sampleRateHz;
  const maxBytes = sampleRateHz * 2 * env.STT_MAX_TURN_SECONDS;
  const clipped = pcm.length > maxBytes ? pcm.subarray(0, maxBytes) : pcm;
  const wav = pcm16LeMonoToWav(clipped, sampleRateHz);
  const model = options.model ?? env.OPENAI_STT_TRANSCRIPTION_MODEL;

  const url = `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/audio/transcriptions`;
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "turn.wav");
  form.append("model", model);
  if (options.language) {
    form.append("language", options.language);
  }
  if (options.prompt?.trim()) {
    form.append("prompt", options.prompt.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_HTTP_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn(
        {
          event: "openai_stt_turn_failed",
          status: response.status,
          model,
          bodyPreview: body.slice(0, 300),
          pcmBytes: clipped.length,
          sampleRateHz
        },
        "openai transcription turn failed"
      );
      throw new HttpError(502, `openai_stt_http_${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        event: "openai_stt_turn_ok",
        model,
        sttMs: durationMs,
        sttChars: text.length,
        pcmBytes: clipped.length,
        sampleRateHz
      },
      "openai transcription turn ok"
    );
    return { text, durationMs };
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(499, "openai_stt_turn_aborted");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `openai_stt_turn_error: ${message}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
