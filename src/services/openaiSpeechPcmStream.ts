import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";

export type StreamSpeechPcmOptions = {
  text: string;
  model?: string;
  voice?: string;
  onChunk: (pcm16: Buffer) => void | Promise<void>;
  signal?: AbortSignal;
};

const TTS_SAMPLE_RATE_HZ = 24_000;

/**
 * OpenAI Audio Speech API — streaming PCM chunks (s16le mono @ 24 kHz).
 */
export async function streamOpenAiSpeechPcm(options: StreamSpeechPcmOptions): Promise<{
  totalBytes: number;
  firstByteMs: number | null;
  durationMs: number;
}> {
  const model = options.model ?? env.OPENAI_TTS_MODEL;
  const voice = options.voice ?? env.OPENAI_TTS_VOICE ?? env.OPENAI_REALTIME_VOICE;
  const input = options.text.trim();
  if (!input) {
    throw new HttpError(400, "openai_speech_input_empty");
  }

  const url = `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/audio/speech`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_HTTP_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  const startedAt = Date.now();
  let firstByteMs: number | null = null;
  let totalBytes = 0;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        voice,
        input,
        response_format: "pcm",
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn(
        {
          event: "openai_speech_pcm_stream_failed",
          status: response.status,
          model,
          bodyPreview: body.slice(0, 300)
        },
        "openai speech pcm stream failed"
      );
      throw new HttpError(502, `openai_speech_stream_http_${response.status}`);
    }

    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length >= 2) {
        if (firstByteMs === null) {
          firstByteMs = Date.now() - startedAt;
        }
        totalBytes += buf.length;
        await options.onChunk(buf);
      }
      return { totalBytes, firstByteMs, durationMs: Date.now() - startedAt };
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }
      const chunk = Buffer.from(value);
      if (firstByteMs === null) {
        firstByteMs = Date.now() - startedAt;
      }
      totalBytes += chunk.length;
      await options.onChunk(chunk);
    }

    logger.info(
      {
        event: "openai_speech_pcm_stream_ok",
        model,
        voice,
        pcmBytes: totalBytes,
        ttsFirstByteMs: firstByteMs,
        inputChars: input.length
      },
      "openai speech pcm stream ok"
    );

    return { totalBytes, firstByteMs, durationMs: Date.now() - startedAt };
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(499, "openai_speech_stream_aborted");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `openai_speech_stream_error: ${message}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export const OPENAI_TTS_PCM_SAMPLE_RATE_HZ = TTS_SAMPLE_RATE_HZ;
