import { logger } from "../logging/logger";
import { rtmpPcmTransportDebug } from "./rtmpPcmTransportDebug";
import { rtmpTtsSessionManager, type RtmpTtsWriteResult } from "./rtmpTtsSessionManager";

type RealtimeEventInput = {
  meetingId?: string;
  sessionId?: string;
  type: string;
  rawPayload?: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;
};

type TapRegistration = {
  internalMeetingId: string;
  numericMeetingId: number;
};

const AUDIO_DELTA_TYPES = new Set([
  "response.audio.delta",
  "response.output_audio.delta",
  "output_audio.delta"
]);

/** Max PCM held per meeting when publisher/tap not ready yet (prototype safety cap). */
const PENDING_PCM_MAX_BYTES = 2 * 1024 * 1024;

class RtmpTtsAudioTap {
  private readonly byInternal = new Map<string, TapRegistration>();
  private readonly pendingPcm = new Map<number, Buffer[]>();
  private readonly pendingBytes = new Map<number, number>();
  private readonly deltaLogCounters = new Map<string, number>();

  register(internalMeetingId: string, numericMeetingId: number): void {
    this.unregisterByNumeric(numericMeetingId);
    this.byInternal.set(internalMeetingId, { internalMeetingId, numericMeetingId });
    this.byInternal.set(String(numericMeetingId), { internalMeetingId, numericMeetingId });
    logger.info(
      {
        event: "rtmp_tts_tap_register",
        internalMeetingId,
        numericMeetingId,
        tapKeys: this.byInternal.size,
        publisherActive: rtmpTtsSessionManager.isActive(numericMeetingId)
      },
      "rtmp tts audio tap registered"
    );
    this.flushPending(numericMeetingId, "register");
  }

  unregister(internalMeetingId: string): void {
    const reg = this.byInternal.get(internalMeetingId);
    if (reg) {
      this.unregisterByNumeric(reg.numericMeetingId);
      return;
    }
    this.byInternal.delete(internalMeetingId);
  }

  unregisterByNumeric(numericMeetingId: number): void {
    for (const [internalId, reg] of this.byInternal.entries()) {
      if (reg.numericMeetingId === numericMeetingId) {
        this.byInternal.delete(internalId);
      }
    }
    const droppedChunks = this.pendingPcm.get(numericMeetingId)?.length ?? 0;
    const droppedBytes = this.pendingBytes.get(numericMeetingId) ?? 0;
    this.pendingPcm.delete(numericMeetingId);
    this.pendingBytes.delete(numericMeetingId);
    if (droppedChunks > 0) {
      logger.info(
        {
          event: "rtmp_tts_tap_unregister",
          numericMeetingId,
          droppedChunks,
          droppedBytes
        },
        "rtmp tts audio tap unregistered"
      );
    }
  }

  /** Call after ffmpeg publisher is spawned so pre-register PCM is drained. */
  flushPending(numericMeetingId: number, reason = "publisher_ready"): void {
    this.flushPendingInternal(numericMeetingId, reason);
  }

  handleRealtimeEvent(input: RealtimeEventInput): void {
    if (!isAudioDeltaType(input.type)) {
      return;
    }

    const meetingId = input.meetingId?.trim();
    const deltaMeta = inspectAudioDelta(input);
    this.logAudioDeltaReceived({
      meetingId,
      sessionId: input.sessionId,
      type: input.type,
      deltaMeta
    });

    if (!meetingId) {
      logger.warn(
        {
          event: "rtmp_tts_audio_delta_missing_meeting_id",
          sessionId: input.sessionId,
          type: input.type,
          deltaExists: deltaMeta.deltaExists,
          deltaB64Length: deltaMeta.deltaB64Length
        },
        "openai realtime audio delta without meetingId — dropped"
      );
      return;
    }

    if (!deltaMeta.deltaExists || !deltaMeta.deltaB64) {
      logger.warn(
        {
          event: "rtmp_tts_audio_delta_empty",
          meetingId,
          sessionId: input.sessionId,
          type: input.type
        },
        "openai realtime audio delta has no pcm payload — dropped"
      );
      return;
    }

    const pcm16 = Buffer.from(deltaMeta.deltaB64, "base64");
    if (pcm16.length === 0) {
      return;
    }

    const reg = this.byInternal.get(meetingId);
    const numericMeetingId = reg?.numericMeetingId ?? parseNumericMeetingId(meetingId);
    if (numericMeetingId !== undefined) {
      rtmpPcmTransportDebug.recordDeltaIngress({
        meetingId: numericMeetingId,
        meetingIdLabel: meetingId,
        sessionId: input.sessionId,
        type: input.type,
        pcmBytes: pcm16.length,
        deltaB64Length: deltaMeta.deltaB64Length,
        tapExists: Boolean(reg),
        publisherActive: reg ? rtmpTtsSessionManager.isActive(reg.numericMeetingId) : false
      });
    }

    if (!reg) {
      this.bufferPending(meetingId, pcm16, "tap_not_registered");
      return;
    }

    if (!rtmpTtsSessionManager.isActive(reg.numericMeetingId)) {
      this.bufferPendingForNumeric(reg.numericMeetingId, pcm16, "publisher_not_active");
      return;
    }

    this.writePcm16(reg.numericMeetingId, pcm16, meetingId);
  }

  /**
   * Direct PCM ingress (smoke loop, tests) — does not parse Realtime delta JSON.
   * Keeps stdin open; does not stop the publisher.
   */
  
  writePcm16Direct(
    numericMeetingId: number,
    pcm16: Buffer,
    meta?: { source?: string; phrase?: string }
  ): RtmpTtsWriteResult {
    return this.writePcm16(numericMeetingId, pcm16, String(numericMeetingId), meta);
  }

  private writePcm16(
    numericMeetingId: number,
    pcm16: Buffer,
    meetingIdForLog: string,
    meta?: { source?: string; phrase?: string }
  ): RtmpTtsWriteResult {
    const result = rtmpTtsSessionManager.writePcm16(numericMeetingId, pcm16);
    const logKey = String(numericMeetingId);
    const count = (this.deltaLogCounters.get(logKey) ?? 0) + 1;
    this.deltaLogCounters.set(logKey, count);

    const snapshot = rtmpTtsSessionManager.getSnapshot(numericMeetingId);
    const logEverySmoke = meta?.source === "rtmp_ingress_smoke";
    if (count === 1 || count % 50 === 0 || !result.written || logEverySmoke) {
      logger.info(
        {
          event: meta?.source === "rtmp_ingress_smoke" ? "rtmp_ingress_smoke_write_pcm" : "rtmp_tts_write_pcm",
          meetingId: meetingIdForLog,
          numericMeetingId,
          pcmBytes: pcm16.length,
          phrase: meta?.phrase,
          source: meta?.source,
          tapExists: this.byInternal.has(meetingIdForLog) || this.byInternal.has(String(numericMeetingId)),
          publisherActive: rtmpTtsSessionManager.isActive(numericMeetingId),
          written: result.written,
          reason: result.reason,
          totalBytesWritten: result.totalBytesWritten,
          chunksWritten: result.chunksWritten,
          lastWriteAt: snapshot.lastWriteAt ?? null,
          ffmpegStderr: snapshot.lastStderr ?? null
        },
        result.written ? "rtmp tts write pcm" : "rtmp tts write pcm skipped"
      );
    }
    return result;
  }

  private bufferPending(meetingId: string, pcm16: Buffer, reason: string): void {
    const numeric = parseNumericMeetingId(meetingId);
    if (numeric === undefined) {
      logger.warn(
        {
          event: "rtmp_tts_pcm_buffer_drop",
          meetingId,
          pcmBytes: pcm16.length,
          reason: "unknown_meeting_id_format"
        },
        "rtmp tts pcm buffer drop"
      );
      return;
    }
    this.bufferPendingForNumeric(numeric, pcm16, reason);
  }

  private bufferPendingForNumeric(numericMeetingId: number, pcm16: Buffer, reason: string): void {
    const chunks = this.pendingPcm.get(numericMeetingId) ?? [];
    const bytes = (this.pendingBytes.get(numericMeetingId) ?? 0) + pcm16.length;
    if (bytes > PENDING_PCM_MAX_BYTES) {
      logger.warn(
        {
          event: "rtmp_tts_pcm_buffer_overflow",
          numericMeetingId,
          pcmBytes: pcm16.length,
          bufferedBytes: bytes,
          maxBytes: PENDING_PCM_MAX_BYTES,
          reason
        },
        "rtmp tts pcm buffer overflow — chunk dropped"
      );
      return;
    }
    chunks.push(pcm16);
    this.pendingPcm.set(numericMeetingId, chunks);
    this.pendingBytes.set(numericMeetingId, bytes);
    if (chunks.length === 1 || chunks.length % 25 === 0) {
      logger.info(
        {
          event: "rtmp_tts_pcm_buffered",
          numericMeetingId,
          pcmBytes: pcm16.length,
          bufferedChunks: chunks.length,
          bufferedBytes: bytes,
          reason
        },
        "rtmp tts pcm buffered until publisher/tap ready"
      );
    }
  }

  private flushPendingInternal(numericMeetingId: number, reason: string): void {
    const chunks = this.pendingPcm.get(numericMeetingId);
    if (!chunks || chunks.length === 0) {
      return;
    }
    const totalBytes = this.pendingBytes.get(numericMeetingId) ?? 0;
    this.pendingPcm.delete(numericMeetingId);
    this.pendingBytes.delete(numericMeetingId);

    logger.info(
      {
        event: "rtmp_tts_pcm_flush",
        numericMeetingId,
        chunks: chunks.length,
        totalBytes,
        reason,
        publisherActive: rtmpTtsSessionManager.isActive(numericMeetingId)
      },
      "rtmp tts flushing buffered pcm to ffmpeg stdin"
    );

    if (!rtmpTtsSessionManager.isActive(numericMeetingId)) {
      logger.warn(
        { event: "rtmp_tts_pcm_flush_skipped", numericMeetingId, reason: "publisher_not_active" },
        "rtmp tts pcm flush skipped — publisher not active"
      );
      return;
    }

    for (const chunk of chunks) {
      this.writePcm16(numericMeetingId, chunk, String(numericMeetingId));
    }
  }

  private logAudioDeltaReceived(input: {
    meetingId?: string;
    sessionId?: string;
    type: string;
    deltaMeta: AudioDeltaMeta;
  }): void {
    const key = `${input.sessionId ?? "no-session"}:${input.meetingId ?? "no-meeting"}`;
    const count = (this.deltaLogCounters.get(`delta:${key}`) ?? 0) + 1;
    this.deltaLogCounters.set(`delta:${key}`, count);

    if (count === 1 || count % 25 === 0) {
      logger.info(
        {
          event: "openai_realtime_audio_delta",
          meetingId: input.meetingId,
          sessionId: input.sessionId,
          type: input.type,
          deltaExists: input.deltaMeta.deltaExists,
          deltaB64Length: input.deltaMeta.deltaB64Length,
          approxPcmBytes: input.deltaMeta.approxPcmBytes,
          deltaCount: count
        },
        "openai realtime audio delta"
      );
    }
  }
}

type AudioDeltaMeta = {
  deltaExists: boolean;
  deltaB64Length: number;
  approxPcmBytes: number;
  deltaB64: string | null;
};

function isAudioDeltaType(type: string): boolean {
  return AUDIO_DELTA_TYPES.has(type);
}

export function inspectAudioDelta(input: RealtimeEventInput): AudioDeltaMeta {
  const deltaB64 = extractAudioDelta(input);
  const deltaB64Length = deltaB64?.length ?? 0;
  return {
    deltaExists: deltaB64Length > 0,
    deltaB64Length,
    approxPcmBytes: deltaB64Length > 0 ? Math.floor((deltaB64Length * 3) / 4) : 0,
    deltaB64
  };
}

function extractAudioDelta(input: RealtimeEventInput): string | null {
  const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
  for (const payload of payloads) {
    const delta = payload.delta ?? payload.audio ?? payload.pcm16;
    if (typeof delta === "string" && delta.trim()) {
      return delta.trim();
    }
  }
  return null;
}

function parseNumericMeetingId(meetingId: string): number | undefined {
  const trimmed = meetingId.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const match = /^nullxes-meeting-(\d+)$/.exec(trimmed);
  if (match) {
    return Number(match[1]);
  }
  return undefined;
}

export const rtmpTtsAudioTap = new RtmpTtsAudioTap();
