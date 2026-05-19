import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";

export type OpenAiSpeechPcmOptions = {
  text: string;
  model?: string;
  voice?: string;
};

/**
 * OpenAI Audio Speech API — raw PCM (s16le mono @ 24 kHz) for ffmpeg RTMP ingress smoke.
 * @see https://platform.openai.com/docs/api-reference/audio/createSpeech
 */
export async function fetchOpenAiSpeechPcm(options: OpenAiSpeechPcmOptions): Promise<Buffer> {
  const model = options.model ?? env.OPENAI_TTS_MODEL;
  const voice = options.voice ?? env.OPENAI_TTS_VOICE ?? env.OPENAI_REALTIME_VOICE;
  const input = options.text.trim();
  if (!input) {
    throw new HttpError(400, "openai_speech_input_empty");
  }

  const url = `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/audio/speech`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_HTTP_TIMEOUT_MS);

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
        response_format: "pcm"
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn(
        {
          event: "openai_speech_pcm_failed",
          status: response.status,
          model,
          voice,
          bodyPreview: body.slice(0, 300)
        },
        "openai speech pcm request failed"
      );
      throw new HttpError(502, `openai_speech_http_${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const pcm = Buffer.from(arrayBuffer);
    if (pcm.length < 2) {
      throw new HttpError(502, "openai_speech_pcm_empty");
    }
    if (pcm.subarray(0, 4).toString("ascii") === "RIFF") {
      logger.warn(
        { event: "openai_speech_pcm_unexpected_wav", bytes: pcm.length },
        "openai speech returned WAV header — expected raw pcm"
      );
      throw new HttpError(502, "openai_speech_pcm_not_raw");
    }

    logger.info(
      {
        event: "openai_speech_pcm_ok",
        model,
        voice,
        pcmBytes: pcm.length,
        inputChars: input.length
      },
      "openai speech pcm generated"
    );
    return pcm;
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(504, "openai_speech_pcm_timeout");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `openai_speech_pcm_error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
