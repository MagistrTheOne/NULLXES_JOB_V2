import { env, resolveRuntimeVideoEngine } from "../config/env";
import { logger } from "../logging/logger";
import { AvatarRuntimeEngine } from "./avatarRuntimeEngine";
import { MeetingControlWsHub } from "./meetingControlWsHub";
import { OpenAiRealtimeOrchestrator } from "./openaiOrchestrator";
import { RunpodWorkerClient } from "./runpodWorkerClient";
import { StreamAgentPublisher } from "./streamAgentPublisher";
import type { RuntimeEventStore } from "./runtimeEventStore";
import { MasterClock } from "./masterClock";
import { SessionOrchestrator } from "./sessionOrchestrator";
import { withRetries } from "./retry";
import type { RuntimeSessionStateStore } from "./runtimeSessionStateStore";
import type { RuntimeFrameEnvelope } from "./a2f-runtime/contracts";
import type { A2FRuntimeClient } from "./a2f-runtime/runtimeServiceClient";
import { ArachneAvatarFramesClient } from "./arachneAvatarFramesClient";

type RuntimeState = "idle" | "starting" | "active" | "degraded" | "paused" | "stopped";

type RuntimeSession = {
  meetingId: string;
  numericMeetingId?: number;
  sessionId: string;
  state: RuntimeState;
  createdAtMs: number;
  updatedAtMs: number;
  epoch: number;
  paused: boolean;
  subtitlesSuppressed: boolean;
  seenTranscriptKeys: Set<string>;
  clock: MasterClock;
  orchestrator: SessionOrchestrator;
  openai: OpenAiRealtimeOrchestrator;
  runpod: RunpodWorkerClient;
  engine?: AvatarRuntimeEngine;
  /** Unsubscribe A2F facial tap used for `behavior_static` video modulation. */
  facialFrameUnsub?: () => void;
};

type RealtimeEventInput = {
  meetingId?: string;
  sessionId: string;
  type: string;
  rawPayload?: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;
  timestampMs?: number;
};

export class AvatarRuntimeSessionManager {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly numericToInternal = new Map<number, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      runtimeEvents?: RuntimeEventStore;
      controlWsHub?: MeetingControlWsHub;
      inactiveTtlMs?: number;
      sessionState?: RuntimeSessionStateStore;
      a2fRuntime?: A2FRuntimeClient;
    }
  ) {}

  async startForMeeting(input: { meetingId: string; numericMeetingId?: number; sessionId?: string }): Promise<void> {
    const existing = this.sessions.get(input.meetingId);
    if (existing && existing.state !== "stopped") {
      return;
    }

    const sessionId = input.sessionId ?? input.meetingId;
    const clock = new MasterClock();
    const sessionOrchestrator = new SessionOrchestrator();
    const openai = new OpenAiRealtimeOrchestrator({ runtimeEvents: this.options.runtimeEvents, clock });
    openai.start(input.meetingId, sessionId);
    const runpod = new RunpodWorkerClient();
    const session: RuntimeSession = {
      meetingId: input.meetingId,
      numericMeetingId: input.numericMeetingId,
      sessionId,
      state: "starting",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      epoch: 0,
      paused: false,
      subtitlesSuppressed: false,
      seenTranscriptKeys: new Set(),
      clock,
      orchestrator: sessionOrchestrator,
      openai,
      runpod
    };
    this.sessions.set(input.meetingId, session);
    if (env.A2F_RUNTIME_ENABLED) {
      this.options.a2fRuntime?.startSession({
        meetingId: input.meetingId,
        targetFps: env.A2F_RUNTIME_TARGET_FPS,
        windowMs: env.A2F_RUNTIME_WINDOW_MS,
        hopMs: env.A2F_RUNTIME_HOP_MS,
        maxQueueMs: env.A2F_RUNTIME_MAX_QUEUE_MS
      });
    }
    await this.options.sessionState?.upsert(input.meetingId, {
      activeSpeaker: "assistant",
      phase: "starting",
      engine: this.isBehaviorStreamPipelineEnabled()
        ? "behavior_static"
        : this.isArachneAvatarPipelineEnabled()
          ? resolveRuntimeVideoEngine()
          : "none",
      degradationLevel: 0,
      avatarReady: false
    });
    if (typeof input.numericMeetingId === "number") {
      this.numericToInternal.set(input.numericMeetingId, input.meetingId);
    }

    if (
      !this.isArachneAvatarPipelineEnabled() &&
      !this.isBehaviorStreamPipelineEnabled()
    ) {
      session.state = "active";
      this.touch(session);
      await this.options.sessionState?.upsert(input.meetingId, {
        phase: "in_meeting",
        engine: "none",
        degradationLevel: 0,
        avatarReady: false
      });
      return;
    }

    if (this.isBehaviorStreamPipelineEnabled()) {
      const facialFrameRef: { current: RuntimeFrameEnvelope | null } = { current: null };
      let facialFrameUnsub: (() => void) | undefined;
      if (env.A2F_RUNTIME_ENABLED && this.options.a2fRuntime) {
        facialFrameUnsub = this.options.a2fRuntime.subscribe(input.meetingId, {
          format: "json",
          onFrame: (frame) => {
            if (!(frame instanceof Uint8Array)) {
              facialFrameRef.current = frame;
            }
          }
        });
      }
      const engine = new AvatarRuntimeEngine({
        orchestrator: openai,
        publisher: new StreamAgentPublisher(),
        runpod,
        clock,
        runtimeEvents: this.options.runtimeEvents,
        facialFrameRef
      });
      session.engine = engine;
      session.facialFrameUnsub = facialFrameUnsub;
      try {
        await engine.start({
          meetingId: input.meetingId,
          sessionId,
          openAiAudioRateHz: 24_000,
          liveKitRoomName: input.meetingId
        });
        session.state = "active";
        this.touch(session);
        await this.options.sessionState?.upsert(input.meetingId, {
          phase: "in_meeting",
          engine: "behavior_static",
          degradationLevel: 0,
          avatarReady: true
        });
        await this.options.runtimeEvents?.append({
          type: "avatar.runtime.started",
          meetingId: input.meetingId,
          sessionId,
          actor: "gateway",
          payload: { numericMeetingId: input.numericMeetingId, transport: "stream", renderer: "behavior_static" }
        }).catch(() => undefined);
      } catch (error) {
        session.facialFrameUnsub?.();
        session.facialFrameUnsub = undefined;
        session.state = "degraded";
        session.engine = undefined;
        this.touch(session);
        await this.options.sessionState?.upsert(input.meetingId, {
          phase: "degraded",
          degradationLevel: 2,
          avatarReady: false
        });
        await this.options.runtimeEvents?.append({
          type: "avatar.runtime.degraded",
          meetingId: input.meetingId,
          sessionId,
          actor: "gateway",
          payload: { reason: "behavior_static_engine_start_failed", error: error instanceof Error ? error.message : String(error) }
        }).catch(() => undefined);
        logger.warn({ meetingId: input.meetingId, err: error }, "behavior_static engine start failed");
      }
      return;
    }

    const readiness = await this.checkArachneReadiness();
    if (!readiness.ok) {
      session.state = "degraded";
      this.touch(session);
      await this.options.sessionState?.upsert(input.meetingId, {
        phase: "degraded",
        degradationLevel: 2,
        avatarReady: false
      });
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { reason: readiness.reason, detail: readiness.detail }
      }).catch(() => undefined);
      await this.options.runtimeEvents?.append({
        type: "engine_degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { degradationLevel: 2, reason: readiness.reason, detail: readiness.detail }
      }).catch(() => undefined);
      logger.warn({ meetingId: input.meetingId, reason: readiness.reason, detail: readiness.detail }, "arachne runtime degraded before start");
      return;
    }

    const engine = new AvatarRuntimeEngine({
      orchestrator: openai,
      publisher: new StreamAgentPublisher(),
      runpod,
      clock,
      runtimeEvents: this.options.runtimeEvents
    });
    session.engine = engine;
    try {
      await engine.start({
        meetingId: input.meetingId,
        sessionId,
        openAiAudioRateHz: 24_000,
        liveKitRoomName: input.meetingId
      });
      session.state = "active";
      this.touch(session);
      await this.options.sessionState?.upsert(input.meetingId, {
        phase: "in_meeting",
        engine: resolveRuntimeVideoEngine(),
        degradationLevel: 0,
        avatarReady: true
      });
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.started",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { numericMeetingId: input.numericMeetingId, transport: "stream", renderer: resolveRuntimeVideoEngine() }
      }).catch(() => undefined);
    } catch (error) {
      session.state = "degraded";
      session.engine = undefined;
      this.touch(session);
      await this.options.sessionState?.upsert(input.meetingId, {
        phase: "degraded",
        degradationLevel: 2,
        avatarReady: false
      });
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { reason: "engine_start_failed", error: error instanceof Error ? error.message : String(error) }
      }).catch(() => undefined);
      await this.options.runtimeEvents?.append({
        type: "engine_degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { degradationLevel: 2, reason: "engine_start_failed" }
      }).catch(() => undefined);
      logger.warn({ meetingId: input.meetingId, err: error }, "avatar runtime engine start failed");
    }
  }

  handleRealtimeEvent(input: RealtimeEventInput): void {
    const session = this.resolveSession(input.meetingId);
    if (!session || session.state === "stopped") {
      return;
    }
    this.touch(session);
    const type = input.type;

    if (type === "input_audio_buffer.speech_started" || type === "speech.started") {
      session.orchestrator.onVadUtterance();
      void this.options.sessionState?.upsert(session.meetingId, { activeSpeaker: "candidate" });
      void this.options.runtimeEvents?.append({
        type: "speaker_changed",
        meetingId: session.meetingId,
        sessionId: session.sessionId,
        actor: "gateway",
        payload: { activeSpeaker: "candidate" },
        idempotencyKey: `speaker:${session.meetingId}:candidate:${session.epoch}`
      }).catch(() => undefined);
      this.publishActivity(session, "candidate", "speaking");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped" || type === "speech.stopped") {
      this.publishActivity(session, "candidate", "listening");
      return;
    }
    if (type === "response.create" || type === "response.created") {
      session.orchestrator.onAssistantTurnStart("thinking");
      void this.options.sessionState?.upsert(session.meetingId, { activeSpeaker: "assistant", phase: "in_meeting" });
      void this.options.runtimeEvents?.append({
        type: "speaker_changed",
        meetingId: session.meetingId,
        sessionId: session.sessionId,
        actor: "gateway",
        payload: { activeSpeaker: "assistant" },
        idempotencyKey: `speaker:${session.meetingId}:assistant:${session.epoch}`
      }).catch(() => undefined);
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "thinking");
      return;
    }
    if (type === "response.done") {
      session.orchestrator.onAssistantTurnEnd();
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "listening");
      return;
    }
    if (type.includes("interrupt") || type.includes("cancel") || type === "conversation.item.truncated") {
      this.interrupt(session.meetingId, "openai_interrupt");
      return;
    }

    const transcriptDelta = this.extractTranscriptDelta(input);
    if (transcriptDelta) {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "speaking");
      this.publishSubtitle(session, input, transcriptDelta);
    }

    const audioDelta = this.extractAudioDelta(input);
    if (audioDelta) {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "speaking");
      this.ingestOpenAiAudioDelta(session.meetingId, {
        pcm16Base64: audioDelta,
        sampleRateHz: 24_000,
        timestampMs: input.timestampMs ?? session.clock.nowMs()
      });
    }
  }

  /** Staged voice pipeline TTS PCM (24 kHz) — same downstream as Realtime audio deltas. */
  ingestStagedTtsPcm16(
    meetingId: string,
    input: { pcm16: Buffer; sampleRateHz: number; timestampMs: number }
  ): void {
    if (env.VOICE_MODE !== "staged") {
      return;
    }
    this.ingestOpenAiAudioDelta(meetingId, {
      pcm16Base64: input.pcm16.toString("base64"),
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });
  }

  ingestOpenAiAudioDelta(
    meetingId: string,
    input: { pcm16Base64: string; sampleRateHz: number; timestampMs: number }
  ): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.paused || session.state === "stopped") {
      return;
    }
    if (session.orchestrator.resolveAudioSource() !== "tts") {
      return;
    }
    const pcm16 = Buffer.from(input.pcm16Base64, "base64");
    if (pcm16.length === 0) {
      return;
    }
    session.openai.ingestTtsPcm16(session.meetingId, {
      pcm16,
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });
    const pcm16Samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
    void this.options.a2fRuntime?.ingestChunk(session.meetingId, {
      timestampMs: input.timestampMs,
      sampleRateHz: 16_000,
      pcm16: input.sampleRateHz === 16_000
        ? pcm16Samples
        : this.downsampleTo16k(pcm16Samples, input.sampleRateHz)
    });
    session.engine?.ingestOpenAiTtsPcm16({
      pcm16,
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });
    this.touch(session);
  }

  pause(meetingId: string, reason = "pause_requested"): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.paused = true;
    session.subtitlesSuppressed = true;
    session.epoch += 1;
    session.state = "paused";
    session.seenTranscriptKeys.clear();
    void this.options.sessionState?.upsert(session.meetingId, { phase: "paused" }).catch(() => undefined);
    session.engine?.pause(reason);
    session.orchestrator.onAssistantTurnEnd();
    this.publishActivity(session, "ai_agent", "paused");
    this.touch(session);
  }

  resume(meetingId: string): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.paused = false;
    session.subtitlesSuppressed = false;
    session.epoch += 1;
    session.state = session.engine ? "active" : "degraded";
    session.seenTranscriptKeys.clear();
    void this.options.sessionState?.upsert(session.meetingId, {
      phase: session.engine ? "in_meeting" : "degraded"
    }).catch(() => undefined);
    session.engine?.resume();
    session.orchestrator.onAssistantTurnEnd();
    this.publishActivity(session, "ai_agent", "listening");
    this.touch(session);
  }

  interrupt(meetingId: string, reason: string): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.epoch += 1;
    session.seenTranscriptKeys.clear();
    session.openai.interrupt(session.meetingId, reason);
    session.engine?.interrupt(reason);
    session.orchestrator.onAssistantTurnEnd();
    void this.options.sessionState?.upsert(session.meetingId, { phase: session.paused ? "paused" : "in_meeting" }).catch(() => undefined);
    this.publishActivity(session, "ai_agent", session.paused ? "paused" : "listening");
    void this.options.runtimeEvents?.append({
      type: "avatar.runtime.interrupted",
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      actor: "gateway",
      payload: { reason, epoch: session.epoch }
    }).catch(() => undefined);
    this.touch(session);
  }

  stop(meetingId: string, reason = "meeting_stop"): void {
    const session = this.resolveSession(meetingId);
    if (!session) return;
    session.state = "stopped";
    session.paused = true;
    session.subtitlesSuppressed = true;
    session.epoch += 1;
    session.seenTranscriptKeys.clear();
    void this.options.sessionState?.upsert(session.meetingId, {
      phase: "stopped",
      avatarReady: false,
      degradationLevel: session.engine ? 0 : 2
    }).catch(() => undefined);
    session.facialFrameUnsub?.();
    session.facialFrameUnsub = undefined;
    session.engine?.stop();
    session.openai.close(session.meetingId);
    if (env.A2F_RUNTIME_ENABLED) {
      this.options.a2fRuntime?.stopSession(session.meetingId);
    }
    if (typeof session.numericMeetingId === "number") {
      this.options.controlWsHub?.publishCurrentQuestion(session.numericMeetingId, null);
      this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "paused");
      this.numericToInternal.delete(session.numericMeetingId);
    }
    void this.options.runtimeEvents?.append({
      type: "avatar.runtime.stopped",
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      actor: "gateway",
      payload: { reason }
    }).catch(() => undefined);
    this.sessions.delete(session.meetingId);
  }

  publishCurrentQuestion(meetingId: string, questionIndex: number | null): void {
    const session = this.resolveSession(meetingId);
    if (session?.numericMeetingId) {
      this.options.controlWsHub?.publishCurrentQuestion(session.numericMeetingId, questionIndex);
    }
  }

  getStats(meetingId: string): Record<string, unknown> | null {
    const session = this.resolveSession(meetingId);
    if (!session) return null;
    return {
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      state: session.state,
      epoch: session.epoch,
      paused: session.paused,
      clockMs: session.clock.nowMs(),
      orchestrator: session.orchestrator.snapshot(),
      engine: session.engine?.getStats() ?? null,
      a2f: this.options.a2fRuntime?.getStats(session.meetingId) ?? null
    };
  }

  setDuplexMode(meetingId: string, mode: "single_assistant" | "duplex"): void {
    const session = this.resolveSession(meetingId);
    if (!session) return;
    session.orchestrator.setDuplexMode(mode);
    this.touch(session);
  }

  setVideoAudioSource(meetingId: string, source: "mic" | "tts" | "auto"): void {
    const session = this.resolveSession(meetingId);
    if (!session) return;
    session.orchestrator.setVideoAudioSource(source);
    this.touch(session);
  }

  setActiveSpeaker(meetingId: string, speaker: "candidate" | "assistant"): void {
    const session = this.resolveSession(meetingId);
    if (!session) return;
    session.orchestrator.forceActiveSpeaker(speaker);
    if (speaker === "candidate") {
      this.publishActivity(session, "candidate", "speaking");
      this.publishActivity(session, "ai_agent", "listening");
    } else {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "speaking");
    }
    void this.options.sessionState?.upsert(session.meetingId, { activeSpeaker: speaker }).catch(() => undefined);
    void this.options.runtimeEvents?.append({
      type: "speaker_changed",
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      actor: "runtime.command",
      payload: { activeSpeaker: speaker },
      idempotencyKey: `speaker:set:${session.meetingId}:${speaker}:${session.epoch}`
    }).catch(() => undefined);
    this.touch(session);
  }

  async markPodHeartbeat(meetingId: string): Promise<void> {
    const current = await this.options.sessionState?.markPodHeartbeat(meetingId);
    if (!current) return;
    const driftMs = current.ownership.gatewayUpdatedAtMs - (current.ownership.podUpdatedAtMs ?? current.updatedAtMs);
    if (Math.abs(driftMs) > 10_000) {
      await this.options.runtimeEvents?.append({
        type: "runtime.state.drift_detected",
        meetingId,
        actor: "gateway",
        payload: { driftMs, revision: current.revision }
      }).catch(() => undefined);
    }
  }

  async syncPodCommandWithRetry(input: {
    fn: () => Promise<void>;
    meetingId: string;
    commandType: string;
    idempotencyKey: string;
  }): Promise<void> {
    try {
      await withRetries(input.fn, { attempts: 3, backoffMs: [200, 600, 1500] });
      await this.options.runtimeEvents?.append({
        type: "runtime.state.synced",
        meetingId: input.meetingId,
        actor: "gateway",
        payload: { commandType: input.commandType },
        idempotencyKey: input.idempotencyKey
      });
    } catch (error) {
      await this.options.runtimeEvents?.append({
        type: "session_failed",
        meetingId: input.meetingId,
        actor: "gateway",
        payload: {
          reason: "pod_sync_failed",
          commandType: input.commandType,
          error: error instanceof Error ? error.message : String(error)
        },
        idempotencyKey: `${input.idempotencyKey}:failed`
      }).catch(() => undefined);
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
  }

  stopSweeper(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private sweep(): void {
    const ttl = this.options.inactiveTtlMs ?? 30 * 60_000;
    const cutoff = Date.now() - ttl;
    for (const session of this.sessions.values()) {
      if (session.updatedAtMs < cutoff) {
        this.stop(session.meetingId, "inactive_runtime_ttl");
      }
    }
  }

  private async checkArachneReadiness(): Promise<{ ok: boolean; reason?: string; detail?: unknown }> {
    if (!env.AVATAR_VIDEO_ENABLED || !this.isArachneAvatarPipelineEnabled()) {
      return { ok: false, reason: "arachne_disabled" };
    }
    if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) {
      return { ok: false, reason: "stream_unconfigured" };
    }
    if (!env.AVATAR_REFERENCE_IMAGE_URL?.trim()) {
      return { ok: false, reason: "reference_image_missing" };
    }
    const client = new ArachneAvatarFramesClient();
    if (!client.isConfigured()) {
      return { ok: false, reason: "avatar_pod_unconfigured" };
    }
    const health = await client.probeHealth().catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }));
    return health.ok ? { ok: true } : { ok: false, reason: "arachne_unhealthy", detail: health.detail };
  }

  private isArachneAvatarPipelineEnabled(): boolean {
    const engine = resolveRuntimeVideoEngine();
    return (
      env.AVATAR_ENABLED &&
      env.AVATAR_VIDEO_ENABLED &&
      (engine === "arachne" || engine === "arachne_ultra_avatar" || engine === "arachne_ultra_video") &&
      Boolean(env.STREAM_API_KEY?.trim()) &&
      Boolean(env.STREAM_API_SECRET?.trim())
    );
  }

  /** Stream SFU agent video+audio without GPU inference — uses `AvatarRuntimeEngine` + `StreamAgentPublisher` at static I420 cadence. */
  private isBehaviorStreamPipelineEnabled(): boolean {
    return (
      env.AVATAR_ENABLED &&
      env.AVATAR_VIDEO_ENABLED &&
      resolveRuntimeVideoEngine() === "behavior_static" &&
      Boolean(env.STREAM_API_KEY?.trim()) &&
      Boolean(env.STREAM_API_SECRET?.trim())
    );
  }

  private resolveSession(meetingId: string | undefined): RuntimeSession | undefined {
    if (!meetingId) return undefined;
    const exact = this.sessions.get(meetingId);
    if (exact) return exact;
    const numeric = Number(meetingId);
    if (Number.isSafeInteger(numeric)) {
      const internal = this.numericToInternal.get(numeric);
      return internal ? this.sessions.get(internal) : undefined;
    }
    return undefined;
  }

  private publishActivity(
    session: RuntimeSession,
    role: "candidate" | "ai_agent",
    value: "listening" | "speaking" | "thinking" | "paused"
  ): void {
    if (typeof session.numericMeetingId !== "number") return;
    if (role === "candidate") {
      if (value !== "listening" && value !== "speaking") return;
      this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "candidate", value);
      return;
    }
    this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", value);
  }

  private publishSubtitle(session: RuntimeSession, event: RealtimeEventInput, text: string): void {
    if (session.paused || session.subtitlesSuppressed || typeof session.numericMeetingId !== "number") return;
    const itemId = String(event.normalizedPayload?.itemId ?? event.rawPayload?.item_id ?? event.rawPayload?.itemId ?? "item");
    const outputIndex = String(event.normalizedPayload?.outputIndex ?? event.rawPayload?.output_index ?? "");
    const contentIndex = String(event.normalizedPayload?.contentIndex ?? event.rawPayload?.content_index ?? "");
    const key = `${event.type}:${itemId}:${outputIndex}:${contentIndex}:${text}`;
    if (session.seenTranscriptKeys.has(key)) {
      return;
    }
    session.seenTranscriptKeys.add(key);
    if (session.seenTranscriptKeys.size > 500) {
      session.seenTranscriptKeys.clear();
    }
    this.options.controlWsHub?.publishSubtitlesDelta(session.numericMeetingId, text);
  }

  private extractTranscriptDelta(input: RealtimeEventInput): string | null {
    if (!input.type.includes("transcript") || !input.type.endsWith(".delta")) {
      return null;
    }
    const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
    for (const payload of payloads) {
      const delta = payload.delta ?? payload.text;
      if (typeof delta === "string" && delta.trim()) {
        return delta;
      }
    }
    return null;
  }

  private extractAudioDelta(input: RealtimeEventInput): string | null {
    if (
      input.type !== "response.audio.delta" &&
      input.type !== "response.output_audio.delta" &&
      input.type !== "output_audio.delta"
    ) {
      return null;
    }
    const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
    for (const payload of payloads) {
      const delta = payload.delta ?? payload.audio ?? payload.pcm16;
      if (typeof delta === "string" && delta.trim()) {
        return delta;
      }
    }
    return null;
  }

  private touch(session: RuntimeSession): void {
    session.updatedAtMs = Date.now();
  }
  private downsampleTo16k(samples: Int16Array, srcRateHz: number): Int16Array {
    if (srcRateHz <= 16_000) {
      return samples;
    }
    const ratio = srcRateHz / 16_000;
    const outLength = Math.max(1, Math.floor(samples.length / ratio));
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      out[i] = samples[Math.floor(i * ratio)] ?? 0;
    }
    return out;
  }
}
