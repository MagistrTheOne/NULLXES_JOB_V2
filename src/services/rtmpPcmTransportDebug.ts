import type { Writable } from "node:stream";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { rtmpTtsSessionManager } from "./rtmpTtsSessionManager";

const ROLLUP_INTERVAL_MS = 5000;
const WRITE_LOG_EVERY_N = 25;
const WRITE_GAP_LOG_THRESHOLD_MS = 200;

type MeetingForensicState = {
  meetingId: number;
  lastDeltaAt?: number;
  lastWriteAt?: number;
  deltasCount: number;
  writesCount: number;
  deltaGapSum: number;
  maxDeltaGapMs: number;
  writeGapSum: number;
  maxWriteGapMs: number;
  backpressureCount: number;
  backpressureStartedAt?: number;
  lastPublisherActive: boolean;
  lastBytesWritten: number;
  rollupTimer: NodeJS.Timeout;
};

export type DeltaIngressInput = {
  meetingId: number;
  meetingIdLabel: string;
  sessionId?: string;
  type: string;
  pcmBytes: number;
  deltaB64Length: number;
  tapExists: boolean;
  publisherActive: boolean;
};

export type StdinWriteInput = {
  meetingId: number;
  pcmBytes: number;
  writeReturnedOk: boolean;
  stdin: Writable | null | undefined;
  bytesWritten: number;
  chunksWritten: number;
  written: boolean;
  reason?: string;
  publisherActive: boolean;
};

function isEnabled(): boolean {
  return env.RTMP_PCM_TRANSPORT_DEBUG;
}

function stdinWritableLength(stdin: Writable | null | undefined): number | null {
  if (!stdin || typeof stdin !== "object") {
    return null;
  }
  const stream = stdin as Writable & { writableLength?: number };
  return typeof stream.writableLength === "number" ? stream.writableLength : null;
}

function stdinFlags(stdin: Writable | null | undefined): {
  stdinDestroyed: boolean;
  writableEnded: boolean;
} {
  if (!stdin || typeof stdin !== "object") {
    return { stdinDestroyed: true, writableEnded: true };
  }
  const stream = stdin as Writable & { destroyed?: boolean; writableEnded?: boolean };
  return {
    stdinDestroyed: Boolean(stream.destroyed),
    writableEnded: Boolean(stream.writableEnded)
  };
}

class RtmpPcmTransportDebug {
  private readonly meetings = new Map<number, MeetingForensicState>();

  recordDeltaIngress(input: DeltaIngressInput): void {
    if (!isEnabled()) {
      return;
    }

    const state = this.ensureMeeting(input.meetingId);
    const now = Date.now();
    const gapSincePrevDeltaMs =
      state.lastDeltaAt !== undefined ? now - state.lastDeltaAt : null;

    if (gapSincePrevDeltaMs !== null) {
      state.deltaGapSum += gapSincePrevDeltaMs;
      if (gapSincePrevDeltaMs > state.maxDeltaGapMs) {
        state.maxDeltaGapMs = gapSincePrevDeltaMs;
      }
    }

    state.deltasCount += 1;
    state.lastDeltaAt = now;
    state.lastPublisherActive = input.publisherActive;

    logger.info(
      {
        event: "rtmp_pcm_delta_ingress",
        meetingId: input.meetingId,
        meetingIdLabel: input.meetingIdLabel,
        sessionId: input.sessionId ?? null,
        type: input.type,
        pcmBytes: input.pcmBytes,
        deltaB64Length: input.deltaB64Length,
        gapSincePrevDeltaMs,
        tapExists: input.tapExists,
        publisherActive: input.publisherActive
      },
      "rtmp pcm delta ingress"
    );
  }

  recordStdinWrite(input: StdinWriteInput): void {
    if (!isEnabled()) {
      return;
    }

    const state = this.ensureMeeting(input.meetingId);
    const now = Date.now();
    const gapSincePrevWriteMs =
      state.lastWriteAt !== undefined ? now - state.lastWriteAt : null;

    if (input.written && gapSincePrevWriteMs !== null) {
      state.writeGapSum += gapSincePrevWriteMs;
      if (gapSincePrevWriteMs > state.maxWriteGapMs) {
        state.maxWriteGapMs = gapSincePrevWriteMs;
      }
    }

    if (input.written) {
      state.writesCount += 1;
      state.lastWriteAt = now;
    }

    state.lastPublisherActive = input.publisherActive;
    state.lastBytesWritten = input.bytesWritten;

    const shouldLog =
      !input.written ||
      state.writesCount === 1 ||
      state.writesCount % WRITE_LOG_EVERY_N === 0 ||
      (gapSincePrevWriteMs !== null && gapSincePrevWriteMs > WRITE_GAP_LOG_THRESHOLD_MS);

    if (!shouldLog) {
      return;
    }

    const flags = stdinFlags(input.stdin);
    logger.info(
      {
        event: "rtmp_pcm_stdin_write",
        meetingId: input.meetingId,
        pcmBytes: input.pcmBytes,
        gapSincePrevWriteMs,
        writeReturnedOk: input.writeReturnedOk,
        stdinWritableLength: stdinWritableLength(input.stdin),
        stdinDestroyed: flags.stdinDestroyed,
        writableEnded: flags.writableEnded,
        bytesWritten: input.bytesWritten,
        chunksWritten: input.chunksWritten,
        written: input.written,
        reason: input.reason ?? null,
        publisherActive: input.publisherActive
      },
      input.written ? "rtmp pcm stdin write" : "rtmp pcm stdin write skipped"
    );
  }

  recordStdinBackpressure(input: {
    meetingId: number;
    pcmBytes: number;
    stdin: Writable | null | undefined;
  }): void {
    if (!isEnabled()) {
      return;
    }

    const state = this.ensureMeeting(input.meetingId);
    state.backpressureCount += 1;
    if (state.backpressureStartedAt === undefined) {
      state.backpressureStartedAt = Date.now();
    }

    logger.warn(
      {
        event: "rtmp_pcm_stdin_backpressure",
        meetingId: input.meetingId,
        pcmBytes: input.pcmBytes,
        stdinWritableLength: stdinWritableLength(input.stdin),
        backpressureCount: state.backpressureCount
      },
      "rtmp pcm stdin backpressure"
    );
  }

  onStdinDrain(meetingId: number): void {
    if (!isEnabled()) {
      return;
    }

    const state = this.meetings.get(meetingId);
    if (!state) {
      return;
    }

    const startedAt = state.backpressureStartedAt;
    const backpressureDurationMs =
      startedAt !== undefined ? Date.now() - startedAt : null;
    state.backpressureStartedAt = undefined;

    logger.info(
      {
        event: "rtmp_pcm_stdin_drain",
        meetingId,
        backpressureDurationMs,
        backpressureCount: state.backpressureCount
        
      },
      "rtmp pcm stdin drain"
    );
  }

  resetMeeting(meetingId: number): void {
    const state = this.meetings.get(meetingId);
    if (!state) {
      return;
    }
    clearInterval(state.rollupTimer);
    this.meetings.delete(meetingId);
  }

  private ensureMeeting(meetingId: number): MeetingForensicState {
    let state = this.meetings.get(meetingId);
    if (state) {
      return state;
    }

    state = {
      meetingId,
      deltasCount: 0,
      writesCount: 0,
      deltaGapSum: 0,
      maxDeltaGapMs: 0,
      writeGapSum: 0,
      maxWriteGapMs: 0,
      backpressureCount: 0,
      lastPublisherActive: false,
      lastBytesWritten: 0,
      rollupTimer: setInterval(() => {
        this.emitRollup(meetingId);
      }, ROLLUP_INTERVAL_MS)
    };
    this.meetings.set(meetingId, state);
    return state;
  }

  private emitRollup(meetingId: number): void {
    const state = this.meetings.get(meetingId);
    if (!state) {
      return;
    }

    const deltaGapSamples = Math.max(state.deltasCount - 1, 0);
    const writeGapSamples = Math.max(state.writesCount - 1, 0);

    logger.info(
      {
        event: "rtmp_pcm_transport_rollup",
        meetingId,
        deltasCount: state.deltasCount,
        writesCount: state.writesCount,
        bytesWritten: state.lastBytesWritten,
        avgDeltaGapMs:
          deltaGapSamples > 0 ? Math.round(state.deltaGapSum / deltaGapSamples) : null,
        maxDeltaGapMs: state.maxDeltaGapMs,
        avgWriteGapMs:
          writeGapSamples > 0 ? Math.round(state.writeGapSum / writeGapSamples) : null,
        maxWriteGapMs: state.maxWriteGapMs,
        backpressureCount: state.backpressureCount,
        publisherActive: rtmpTtsSessionManager.isActive(meetingId)

      },
      "rtmp pcm transport rollup"
    );

    state.deltaGapSum = 0;
    state.maxDeltaGapMs = 0;
    state.writeGapSum = 0;
    state.maxWriteGapMs = 0;
    state.deltasCount = 0;
    state.writesCount = 0;
    state.backpressureCount = 0;
  }
}

export const rtmpPcmTransportDebug = new RtmpPcmTransportDebug();
