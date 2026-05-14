import type { AvatarState } from "../services/avatarStateStore";
import type { CandidateAdmissionStatusView, MeetingRecord, MeetingTransitionEvent } from "./meeting";
import type { StoredInterview } from "./interview";
import type { SessionRecord } from "./realtime";

export type RuntimeEventType =
  | "runtime.snapshot.requested"
  | "runtime.command.requested"
  | "runtime.question_advanced"
  | "meeting.transition"
  | "meeting.control.started"
  | "meeting.control.stopped"
  | "meeting.control.pause_changed"
  | "meeting.control.ws.connected"
  | "meeting.control.ws.disconnected"
  | "meeting.control.activity_mode_changed"
  | "meeting.control.current_question_changed"
  | "meeting.control.subtitles_delta"
  | "meeting.control.deinit_completed"
  | "avatar.runtime.started"
  | "avatar.runtime.stopped"
  | "avatar.runtime.degraded"
  | "avatar.runtime.interrupted"
  | "speaker_changed"
  | "engine_degraded"
  | "av_sync_warning"
  | "session_failed"
  | "runtime.state.synced"
  | "runtime.state.drift_detected"
  | "a2f.frame.generated"
  | "a2em.frame.generated"
  | "runtime.latency.warn"
  | "runtime.queue.backpressure"
  | "candidate.admission.acquire"
  | "candidate.admission.release"
  | "candidate.admission.decision"
  | "realtime.session.event"
  | "realtime.orchestrated.started"
  | "realtime.mic.append"
  | "avatar.event"
  | "openai.orchestrator.started"
  | "openai.mic.append"
  | "openai.orchestrator.closed"
  | "avatar.telemetry"
  | "avatar.buffering"
  | "avatar.degraded"
  | "stream.token.issued"
  | "observer_command_denied"
  | "runtime.lease.acquired"
  | "runtime.lease.rejected";

export interface RuntimeEvent {
  id: string;
  type: RuntimeEventType;
  meetingId?: string;
  sessionId?: string;
  jobAiId?: number;
  actor?: string;
  timestampMs: number;
  revision: number;
  payload: Record<string, unknown>;
}

export type RuntimeCommandType =
  | "agent.pause"
  | "agent.resume"
  | "agent.cancel_response"
  | "agent.force_next_question"
  | "agent.end_interview"
  | "avatar.duplex_mode.set"
  | "avatar.video_audio_source.set"
  | "avatar.speaker.set"
  | "observer.reconnect"
  | "session.stop";

export interface RuntimeCommandInput {
  type: RuntimeCommandType;
  issuedBy?: string;
  commandId?: string;
  payload?: Record<string, unknown>;
}

export interface RuntimeCommandRecord {
  commandId: string;
  type: RuntimeCommandType;
  meetingId: string;
  issuedBy: string;
  createdAtMs: number;
  ackStatus: "accepted";
  revision: number;
  payload: Record<string, unknown>;
}

export interface RuntimeSnapshot {
  schemaVersion: "1.0";
  generatedAtMs: number;
  meetingId: string;
  jobAiId?: number;
  revision: number;
  meeting: {
    status: MeetingRecord["status"];
    triggerSource: string;
    createdAt: number;
    updatedAt: number;
    lastReason?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    history: MeetingTransitionEvent[];
  };
  session?: SessionRecord;
  interview?: Pick<StoredInterview, "jobAiId" | "projection">;
  admission?: CandidateAdmissionStatusView;
  avatar?: AvatarState | null;
  media: {
    provider: "stream" | "livekit_bridge";
    streamCallType: string;
    streamCallId: string;
    candidateUserId: string;
    observerUserIdPrefix: string;
    agentUserId?: string;
  };
  controls: {
    lastCommand?: RuntimeCommandRecord;
    agentPaused: boolean;
  };
  a2fRuntime?: {
    fps: number;
    queueDepthMs: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    droppedFrames: number;
    outputQueueDepth: number;
    gpuSlot: number | null;
  };
  canonicalState?: {
    activeSpeaker: "candidate" | "assistant";
    phase: string;
    engine: string;
    degradationLevel: number;
    avatarReady: boolean;
    revision: number;
    updatedAtMs: number;
  };
  health: {
    ready: boolean;
    warnings: string[];
  };
}
