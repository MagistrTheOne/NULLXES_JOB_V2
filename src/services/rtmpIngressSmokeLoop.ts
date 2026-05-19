import { env } from "../config/env";
import { logger } from "../logging/logger";
import { fetchOpenAiSpeechPcm } from "./openaiSpeechPcm";
import { rtmpTtsAudioTap } from "./rtmpTtsAudioTap";
import { rtmpTtsSessionManager } from "./rtmpTtsSessionManager";

const DEFAULT_SMOKE_PHRASES = [
  "NULLXES ingress runtime test.",
  "Realtime audio pipeline active.",
  "Continuous PCM stream verification."
] as const;

type SmokeHandle = {
  meetingId: number;
  timer: ReturnType<typeof setInterval>;
  phraseIndex: number;
  tickInFlight: boolean;
  stopped: boolean;
  firstWriteLogged: boolean;
};

class RtmpIngressSmokeLoop {
  private readonly handles = new Map<number, SmokeHandle>();

  isEnabled(): boolean {
    return env.RTMP_INGRESS_ENABLED && env.RTMP_INGRESS_SMOKE_ENABLED;
  }

  start(meetingId: number, reason = "publisher_spawned"): void {
    if (!this.isEnabled()) {
      return;
    }
    if (!rtmpTtsSessionManager.isActive(meetingId)) {
      logger.warn(
        { event: "rtmp_ingress_smoke_skip", meetingId, reason: "publisher_not_active" },
        "rtmp ingress smoke not started — publisher inactive"
      );
      return;
    }

    this.stop(meetingId, "restart");

    const intervalMs = env.RTMP_INGRESS_SMOKE_INTERVAL_MS;
    const handle: SmokeHandle = {
      meetingId,
      phraseIndex: 0,
      tickInFlight: false,
      stopped: false,
      firstWriteLogged: false,
      timer: setInterval(() => {
        void this.tick(meetingId);
      }, intervalMs)
    };
    this.handles.set(meetingId, handle);

    logger.info(
      {
        event: "rtmp_ingress_smoke_started",
        meetingId,
        reason,
        intervalMs,
        phrases: [...DEFAULT_SMOKE_PHRASES]
      },
      "rtmp ingress smoke loop started"
    );

    void this.tick(meetingId);
  }

  stop(meetingId: number, reason = "meeting_stopped"): void {
    const handle = this.handles.get(meetingId);
    if (!handle) {
      return;
    }
    handle.stopped = true;
    clearInterval(handle.timer);
    this.handles.delete(meetingId);
    logger.info(
      { event: "rtmp_ingress_smoke_stopped", meetingId, reason },
      "rtmp ingress smoke loop stopped"
    );
  }

  stopAll(reason: string): void {
    for (const meetingId of [...this.handles.keys()]) {
      this.stop(meetingId, reason);
    }
  }

  private async tick(meetingId: number): Promise<void> {
    const handle = this.handles.get(meetingId);
    if (!handle || handle.stopped || handle.tickInFlight) {
      return;
    }
    if (!rtmpTtsSessionManager.isActive(meetingId)) {
      logger.warn(
        { event: "rtmp_ingress_smoke_publisher_inactive", meetingId },
        "rtmp ingress smoke stopping — publisher no longer active"
      );
      this.stop(meetingId, "publisher_inactive");
      return;
    }

    handle.tickInFlight = true;
    const phrase = DEFAULT_SMOKE_PHRASES[handle.phraseIndex % DEFAULT_SMOKE_PHRASES.length]!;
    handle.phraseIndex += 1;

    try {
      const pcm = await fetchOpenAiSpeechPcm({ text: phrase });
      const result = rtmpTtsAudioTap.writePcm16Direct(meetingId, pcm, {
        source: "rtmp_ingress_smoke",
        phrase
      });
      const snapshot = rtmpTtsSessionManager.getSnapshot(meetingId);

      if (!handle.firstWriteLogged && result.written) {
        handle.firstWriteLogged = true;
        logger.info(
          {
            event: "rtmp_ingress_smoke_first_write",
            meetingId,
            phrase,
            pcmBytes: pcm.length,
            bytesWritten: result.totalBytesWritten,
            chunksWritten: result.chunksWritten,
            lastWriteAt: snapshot.lastWriteAt,
            ffmpegStderr: snapshot.lastStderr ?? null,
            publisherPid: snapshot.pid ?? null
          },
          "rtmp ingress smoke first pcm write"
        );
      }

      logger.info(
        {
          event: "rtmp_ingress_smoke_write",
          meetingId,
          phrase,
          pcmBytes: pcm.length,
          written: result.written,
          reason: result.reason,
          bytesWritten: result.totalBytesWritten,
          chunksWritten: result.chunksWritten,
          lastWriteAt: snapshot.lastWriteAt ?? null,
          ffmpegStderr: snapshot.lastStderr ?? null
        },
        result.written ? "rtmp ingress smoke pcm written" : "rtmp ingress smoke pcm write skipped"
      );
    } catch (err: unknown) {
      logger.warn(
        {
          event: "rtmp_ingress_smoke_tick_failed",
          meetingId,
          phrase,
          error: err instanceof Error ? err.message : String(err)
        },
        "rtmp ingress smoke tick failed"
      );
    } finally {
      handle.tickInFlight = false;
    }
  }
}

export const rtmpIngressSmokeLoop = new RtmpIngressSmokeLoop();
