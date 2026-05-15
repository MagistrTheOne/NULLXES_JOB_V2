import WebSocket from "ws";
import { env } from "../config/env";
import { logger } from "../logging/logger";

export type OpenAiRealtimeWsSttHandlers = {
  onTranscriptDelta?: (delta: string) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onError?: (message: string) => void;
};

function buildRealtimeWsUrl(): string {
  const base = new URL(env.OPENAI_BASE_URL);
  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  const model = (env.OPENAI_STT_MODEL ?? env.OPENAI_REALTIME_MODEL).trim();
  const path = base.pathname.replace(/\/$/, "");
  return `${wsProtocol}//${base.host}${path}/realtime?model=${encodeURIComponent(model)}`;
}

export class OpenAiRealtimeWsSttClient {
  private ws: WebSocket | null = null;
  private readonly pendingAudio: Buffer[] = [];
  private paused = false;
  private closed = false;
  private readonly connectTimeoutMs = env.OPENAI_HTTP_TIMEOUT_MS;

  constructor(
    private readonly meetingId: number,
    private readonly handlers: OpenAiRealtimeWsSttHandlers
  ) {}

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("stt_client_closed");
    }

    const url = buildRealtimeWsUrl();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      });
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("openai_realtime_ws_connect_timeout"));
      }, this.connectTimeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("message", (data) => {
        this.handleMessage(data);
      });

      ws.on("close", () => {
        if (!this.closed) {
          this.handlers.onError?.("openai_realtime_ws_closed");
        }
      });
    });

    this.sendSessionUpdate();
    this.flushPendingAudio();
    logger.info({ meetingId: this.meetingId, url: buildRealtimeWsUrl() }, "openai realtime ws stt connected");
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.flushPendingAudio();
    }
  }

  appendPcm16(chunk: Buffer): void {
    if (this.closed || chunk.length === 0 || this.paused) {
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(chunk);
      if (this.pendingAudio.length > 256) {
        this.pendingAudio.shift();
      }
      return;
    }
    this.sendAudioChunk(chunk);
  }

  close(): void {
    this.closed = true;
    this.pendingAudio.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }

  private sendSessionUpdate(): void {
    const turnDetection = env.OPENAI_TURN_DETECTION_ENABLED
      ? {
          type: env.OPENAI_TURN_DETECTION_TYPE,
          threshold: env.OPENAI_TURN_DETECTION_THRESHOLD,
          prefix_padding_ms: env.OPENAI_TURN_DETECTION_PREFIX_PADDING_MS,
          silence_duration_ms: env.OPENAI_TURN_DETECTION_SILENCE_DURATION_MS
        }
      : { type: "server_vad" as const };

    this.sendJson({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm16",
        input_audio_transcription: {
          model: env.OPENAI_INPUT_TRANSCRIPTION_MODEL
        },
        turn_detection: turnDetection
      }
    });
  }

  private sendAudioChunk(chunk: Buffer): void {
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64")
    });
  }

  private flushPendingAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.paused) {
      return;
    }
    while (this.pendingAudio.length > 0) {
      const chunk = this.pendingAudio.shift();
      if (chunk) {
        this.sendAudioChunk(chunk);
      }
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err: unknown) {
      logger.warn(
        { meetingId: this.meetingId, error: err instanceof Error ? err.message : String(err) },
        "openai realtime ws stt send failed"
      );
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "error") {
      const errObj = parsed.error;
      const message =
        typeof errObj === "object" && errObj !== null && typeof (errObj as { message?: string }).message === "string"
          ? (errObj as { message: string }).message
          : "openai_realtime_ws_error";
      this.handlers.onError?.(message);
      logger.warn({ meetingId: this.meetingId, type, error: parsed.error }, "openai realtime ws stt error event");
      return;
    }

    if (type === "input_audio_buffer.speech_started" || type === "speech.started") {
      this.handlers.onSpeechStarted?.();
      return;
    }
    if (type === "input_audio_buffer.speech_stopped" || type === "speech.stopped") {
      this.handlers.onSpeechStopped?.();
      return;
    }

    if (type.includes("input_audio_transcription") && type.endsWith(".delta")) {
      const delta =
        typeof parsed.delta === "string"
          ? parsed.delta
          : typeof (parsed as { transcript?: string }).transcript === "string"
            ? (parsed as { transcript: string }).transcript
            : "";
      if (delta.trim()) {
        this.handlers.onTranscriptDelta?.(delta);
      }
    }
  }
}
