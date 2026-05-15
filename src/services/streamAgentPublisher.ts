import type { StreamVideoClient } from "@stream-io/video-client";
import WebSocket from "ws";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { mintStreamUserToken } from "./streamCallTokenService";
import { resamplePcm16Linear } from "./audioResampler";

export type StreamPublisherState = "idle" | "connecting" | "connected" | "failed" | "closed";

/** Shared connect payload for Stream vs LiveKit avatar publishers. */
export interface AgentPublisherConnectInput {
  meetingId: string;
  sessionId: string;
  audioInRateHz?: number;
  /** LiveKit room name when it differs from `meetingId` (JobAI uses `nullxes-meeting-<id>` == meetingId). */
  liveKitRoomName?: string;
}

export interface AgentMediaPublisher {
  connect(input: AgentPublisherConnectInput): Promise<void>;
  publishAudioPcm16(chunk: Buffer, timestampMs: number, inputSampleRateHz?: number): Promise<void>;
  publishVideoFrameI420(i420: Buffer, width: number, height: number, timestampMs: number): Promise<void>;
  close(): Promise<void>;
}

type StreamCall = ReturnType<StreamVideoClient["call"]>;

type WrtcModule = typeof import("@roamhq/wrtc");

type AudioSource = InstanceType<WrtcModule["nonstandard"]["RTCAudioSource"]>;
type VideoSource = InstanceType<WrtcModule["nonstandard"]["RTCVideoSource"]>;

const TRACK_TYPE_AUDIO = 1;
const TRACK_TYPE_VIDEO = 2;

function ensureNodePolyfills(): void {
  // Stream Video SDK expects a browser-like global WebSocket.
  (globalThis as unknown as { WebSocket?: unknown }).WebSocket ??= WebSocket;
  // Stream Video SDK reads navigator.*.
  (globalThis as unknown as { navigator?: unknown }).navigator ??= {
    userAgent: `node/${process.version} (${process.platform})`,
    platform: process.platform,
    language: process.env.LANG || "en-US"
  };
  // Prevent Stream SDK from probing real devices.
  const nav = (globalThis as unknown as { navigator?: any }).navigator;
  nav.mediaDevices ??= {
    getUserMedia: async () => {
      throw new Error("getUserMedia is not available in gateway StreamAgentPublisher");
    },
    enumerateDevices: async () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  };
}

function decodePcm16Le(buf: Buffer): Int16Array {
  // Ensure aligned length.
  const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Int16Array(view);
}

/**
 * Stream SFU publisher that joins as agent_<sessionId> and publishes:
 * - agent_audio (PCM16 authoritative audio)
 * - agent_video (I420 frames from clip buffer)
 *
 * Uses the same polyfills pattern proven in `backend/livekit-bridge/src/index.mjs`.
 */
export class StreamAgentPublisher implements AgentMediaPublisher {
  private state: StreamPublisherState = "idle";
  private meetingId: string | null = null;
  private sessionId: string | null = null;

  private stream: StreamVideoClient | null = null;
  private call: StreamCall | null = null;

  private wrtc: WrtcModule | null = null;
  private audioSource: AudioSource | null = null;
  private videoSource: VideoSource | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private publishedAudio = false;
  private publishedVideo = false;

  private audioOutRateHz = 48_000;
  private audioInRateHz = 24_000;

  getState(): StreamPublisherState {
    return this.state;
  }

  async connect(input: AgentPublisherConnectInput): Promise<void> {
    if (this.state === "connected" && this.meetingId === input.meetingId && this.sessionId === input.sessionId) {
      return;
    }
    if (this.state === "connecting") {
      return;
    }
    this.state = "connecting";
    this.meetingId = input.meetingId;
    this.sessionId = input.sessionId;
    this.audioInRateHz = input.audioInRateHz ?? this.audioInRateHz;

    ensureNodePolyfills();

    if (process.platform === "win32") {
      // We rely on wrtc for MediaStream/RTCPeerConnection; production runs on Linux.
      throw new Error("StreamAgentPublisher requires Linux (wrtc globals are not supported on Windows)");
    }

    const wrtc = (await import("@roamhq/wrtc")) as WrtcModule;
    this.wrtc = wrtc;
    (globalThis as any).RTCPeerConnection ??= (wrtc as any).RTCPeerConnection;
    (globalThis as any).RTCSessionDescription ??= (wrtc as any).RTCSessionDescription;
    (globalThis as any).RTCIceCandidate ??= (wrtc as any).RTCIceCandidate;
    (globalThis as any).MediaStream ??= (wrtc as any).MediaStream;
    (globalThis as any).MediaStreamTrack ??= (wrtc as any).MediaStreamTrack;

    const { StreamVideoClient } = await import("@stream-io/video-client");

    if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) {
      this.state = "failed";
      throw new Error("STREAM_API_KEY/STREAM_API_SECRET are required for StreamAgentPublisher");
    }

    const agentUserId = `agent_${input.sessionId}`;
    const token = mintStreamUserToken({
      apiSecret: env.STREAM_API_SECRET,
      userId: agentUserId,
      validitySeconds: 60 * 60 * 4
    });

    const stream = new StreamVideoClient({
      apiKey: env.STREAM_API_KEY,
      user: { id: agentUserId, name: "HR ассистент" },
      token
    });
    const call = stream.call(env.STREAM_CALL_TYPE, input.meetingId);
    await call.join({ create: true });

    const audioSource = new wrtc.nonstandard.RTCAudioSource();
    const videoSource = new wrtc.nonstandard.RTCVideoSource();
    const audioTrack = audioSource.createTrack();
    const videoTrack = videoSource.createTrack();

    // Publish both tracks.
    await call.publish(new MediaStream([audioTrack]), TRACK_TYPE_AUDIO);
    await call.publish(new MediaStream([videoTrack]), TRACK_TYPE_VIDEO);

    this.stream = stream;
    this.call = call;
    this.audioSource = audioSource;
    this.videoSource = videoSource;
    this.audioTrack = audioTrack;
    this.videoTrack = videoTrack;
    this.publishedAudio = true;
    this.publishedVideo = true;
    this.state = "connected";
    logger.info({ meetingId: input.meetingId, sessionId: input.sessionId }, "stream agent publisher connected");
  }

  /**
   * Publish PCM16 audio chunk. Chunk is treated as authoritative master clock and MUST be realtime-safe.
   * The publisher resamples to 48kHz (if needed) and packetizes into 10ms frames for RTCAudioSource.
   */
  async publishAudioPcm16(chunk: Buffer, timestampMs: number, inputSampleRateHz?: number): Promise<void> {
    if (this.state !== "connected" || !this.audioSource) return;
    const inRate = inputSampleRateHz ?? this.audioInRateHz;
    const pcm16 = decodePcm16Le(chunk);
    const resampled = resamplePcm16Linear(pcm16, inRate, this.audioOutRateHz);

    // Packetize to 10ms frames (480 samples at 48kHz mono).
    const frameSamples = Math.floor(this.audioOutRateHz / 100);
    for (let offset = 0; offset < resampled.length; offset += frameSamples) {
      const slice = resampled.subarray(offset, Math.min(offset + frameSamples, resampled.length));
      // Pad last frame to fixed size to keep cadence stable.
      const samples =
        slice.length === frameSamples
          ? slice
          : (() => {
              const padded = new Int16Array(frameSamples);
              padded.set(slice);
              return padded;
            })();

      this.audioSource.onData({
        samples,
        sampleRate: this.audioOutRateHz,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: samples.length,
        timestamp: timestampMs
      } as any);
    }
  }

  /**
   * Publish I420 frame into RTCVideoSource. Caller must schedule at stable FPS.
   */
  async publishVideoFrameI420(i420: Buffer, width: number, height: number, timestampMs: number): Promise<void> {
    if (this.state !== "connected" || !this.videoSource) return;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      logger.warn({ width, height }, "stream publishVideoFrameI420 skipped (invalid dimensions)");
      return;
    }
    const expected = Math.floor((width * height * 3) / 2);
    if (!Buffer.isBuffer(i420) || i420.length !== expected) {
      logger.warn(
        { width, height, expectedBytes: expected, gotBytes: Buffer.isBuffer(i420) ? i420.length : -1 },
        "stream publishVideoFrameI420 skipped (invalid I420 buffer)"
      );
      return;
    }
    try {
      this.videoSource.onFrame({
        width,
        height,
        data: i420,
        timestamp: timestampMs
      } as any);
    } catch (err) {
      logger.warn({ err }, "stream publishVideoFrameI420 failed (non-fatal)");
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    try {
      await this.call?.leave().catch(() => undefined);
    } catch {
      /* noop */
    }
    try {
      await this.stream?.disconnectUser().catch(() => undefined);
    } catch {
      /* noop */
    }
    try {
      this.audioTrack?.stop();
    } catch {
      /* noop */
    }
    try {
      this.videoTrack?.stop();
    } catch {
      /* noop */
    }
    this.audioSource = null;
    this.videoSource = null;
    this.audioTrack = null;
    this.videoTrack = null;
    this.call = null;
    this.stream = null;
    logger.info({ meetingId: this.meetingId, sessionId: this.sessionId }, "stream agent publisher closed");
  }
}

