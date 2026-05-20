import express, { type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { env } from "../config/env";
import { MeetingOrchestrator } from "../services/meetingOrchestrator";
import type { InterviewSyncService } from "../services/interviewSyncService";
import { saveAssistantAudioArtifact } from "../services/assistantAudioArtifacts";
import { StreamRecordingStateError, type StreamRecordingService } from "../services/streamRecordingService";
import type { RuntimeEventStore } from "../services/runtimeEventStore";
import type { MeetingControlWsHub } from "../services/meetingControlWsHub";
import type { AvatarRuntimeSessionManager } from "../services/avatarRuntimeSessionManager";
import { rtmpSttBridge } from "../services/rtmpSttBridge";
import { rtmpTtsAudioTap } from "../services/rtmpTtsAudioTap";
import { stagedVoiceTurnRuntime } from "../services/stagedVoiceTurnRuntime";
import type { DialogueInterviewContext } from "../services/dialogueStateStore";
import { rtmpIngressSmokeLoop } from "../services/rtmpIngressSmokeLoop";
import { rtmpTtsSessionManager, truncateRtmpUrl, type RtmpTtsSessionSnapshot } from "../services/rtmpTtsSessionManager";
import type { MeetingCandidatePresenceTracker } from "../services/meetingCandidatePresence";
import type { FailMeetingInput, MeetingRecord, StartMeetingInput, StopMeetingInput } from "../types/meeting";
import type { JobAiInterviewStatus, StoredInterview } from "../types/interview";

/** Legacy POST /meetings/start body: `meetingId` (preferred) or deprecated `internalMeetingId`; `triggerSource` optional. */
const startMeetingSchema = z
  .object({
    meetingId: z.string().min(1).optional(),
    internalMeetingId: z.string().min(1).optional(),
    triggerSource: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
    sessionId: z.string().min(1).optional()
  })
  .superRefine((data, ctx) => {
    const id = (data.meetingId ?? data.internalMeetingId)?.trim();
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "meetingId is required (string). Legacy alias: internalMeetingId",
        path: ["meetingId"]
      });
    }
  })
  .transform((data): StartMeetingInput => {
    const meetingId = (data.meetingId ?? data.internalMeetingId)!.trim();
    return {
      meetingId,
      triggerSource: data.triggerSource,
      metadata: data.metadata,
      sessionId: data.sessionId
    };
  });

const controlStartMeetingSchema = z.object({
  meetingId: z.number().int().positive(),
  agentRTMPURL: z.string().min(1).optional()
});

/**
 * TEMPORARY STRICT-CHTZ MODE
 *
 * Current integration contract only requires:
 * OpenAI TTS -> ffmpeg -> LiveKit RTMP ingress.
 *
 * Receiver/STT bridge lifecycle is intentionally disabled
 * until duplex realtime contour is required.
 */
const ENABLE_RTMP_RECEIVER = env.VOICE_MODE === "staged" && env.RTMP_RECEIVER_ENABLED;
const STUB_AGENT_RECEIVER_RTMP_URL = "stub://receiver-disabled";

function registerRtmpTtsTapIfRealtime(internalId: string, numericMeetingId: number): void {
  if (env.VOICE_MODE === "realtime") {
    rtmpTtsAudioTap.register(internalId, numericMeetingId);
  }
}

function unregisterRtmpTtsTapIfRealtime(internalId: string): void {
  if (env.VOICE_MODE === "realtime") {
    rtmpTtsAudioTap.unregister(internalId);
  }
}

function flushRtmpTtsTapIfRealtime(numericMeetingId: number, reason: string): void {
  if (env.VOICE_MODE === "realtime") {
    rtmpTtsAudioTap.flushPending(numericMeetingId, reason);
  }
}

function dialogueContextFromStored(stored: StoredInterview): DialogueInterviewContext {
  const raw = stored.rawPayload;
  return {
    candidateFirstName: raw.candidateFirstName,
    candidateLastName: raw.candidateLastName,
    companyName: raw.companyName,
    jobTitle: raw.jobTitle,
    vacancyText: raw.vacancyText,
    specialtyName: raw.specialty?.name,
    greetingSpeech: raw.greetingSpeech,
    finalSpeech: raw.finalSpeech,
    questions: raw.specialty?.questions?.map((q) => ({ text: q.text, order: q.order }))
  };
}

function startStagedVoiceForMeeting(input: {
  internalId: string;
  numericMeetingId: number;
  stored: StoredInterview;
  controlWsHub?: MeetingControlWsHub;
  runtimeEvents?: RuntimeEventStore;
}): void {
  if (env.VOICE_MODE !== "staged") {
    return;
  }
  const sessionId = input.stored.projection.sessionId ?? input.internalId;
  stagedVoiceTurnRuntime.start({
    meetingId: input.internalId,
    sessionId,
    numericMeetingId: input.numericMeetingId,
    sampleRateHz: 16_000,
    dialogueContext: dialogueContextFromStored(input.stored),
    controlWsHub: input.controlWsHub,
    runtimeEvents: input.runtimeEvents
  });
  void stagedVoiceTurnRuntime.agentSpeak(input.internalId).catch((err: unknown) => {
    logger.warn(
      {
        meetingId: input.internalId,
        error: err instanceof Error ? err.message : String(err)
      },
      "staged voice greeting speak failed"
    );
  });
}

function normalizeControlStopMeetingBody(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }
  const o = { ...(body as Record<string, unknown>) };
  const mid = o.meetingId;
  if (typeof mid === "string") {
    const s = mid.trim();
    const m = /^nullxes-meeting-(\d+)$/.exec(s);
    if (m) {
      o.meetingId = Number(m[1]);
    } else if (/^\d+$/.test(s)) {
      o.meetingId = Number(s);
    }
  }
  return o;
}

const controlStopMeetingSchema = z.preprocess(
  normalizeControlStopMeetingBody,
  z.object({
    meetingId: z.number().int().positive(),
    stopReason: z.enum(["candidate_leaved", "candidate_stopped_ui"])
  })
);

const stopMeetingSchema = z.object({
  reason: z.enum(["manual_stop", "superseded_by_other_meeting", "error"]),
  finalStatus: z.enum(["stopped_during_meeting", "completed"]).optional(),
  metadata: z.record(z.unknown()).optional()
});

const failMeetingSchema = z.object({
  status: z.enum(["failed_audio_pool_busy", "failed_connect_ws_audio"]),
  reason: z.string().min(1),
  reasonCode: z
    .enum([
      "openai_call_failed",
      "openai_client_secret_failed",
      "sfu_join_failed",
      "network_timeout",
      "device_permission_denied",
      "audio_input_unavailable",
      "gateway_upstream_unreachable",
      "unknown"
    ])
    .optional(),
  metadata: z.record(z.unknown()).optional()
});

const admissionAcquireSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1).optional()
});

const admissionReleaseSchema = z.object({
  participantId: z.string().min(1),
  reason: z.string().max(200).optional()
});

const admissionDecisionSchema = z.object({
  participantId: z.string().min(1),
  action: z.enum(["approve", "deny"]),
  decidedBy: z.string().min(1).max(120).optional()
});

const recordingStartSchema = z.object({
  callType: z.string().min(1).optional(),
  callId: z.string().min(1).optional()
});

const recordingSyncSchema = z.object({
  jobAiId: z.number().int().positive(),
  callType: z.string().min(1).optional(),
  callId: z.string().min(1).optional()
});

const openAiVoiceSchema = z.object({
  voice: z.string().max(80).optional().nullable()
});

const TERMINAL_JOBAI_STATUSES = new Set<JobAiInterviewStatus>([
  "completed",
  "stopped_during_meeting",
  "canceled",
  "meeting_not_started"
]);

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid request payload", parsed.error.flatten());
  }
  return parsed.data;
}

function readBearerToken(req: Request): string | undefined {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (!auth) {
    return undefined;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim()) ?? /^Bearer:\s*(.+)$/i.exec(auth.trim());
  return bearer?.[1]?.trim();
}

function internalMeetingId(meetingId: number): string {
  return `nullxes-meeting-${meetingId}`;
}

function isFinishedInterview(stored: StoredInterview): boolean {
  return (
    TERMINAL_JOBAI_STATUSES.has(stored.rawPayload.status) ||
    stored.projection.nullxesStatus === "completed" ||
    stored.projection.nullxesStatus === "stopped_during_meeting"
  );
}

function isFinishedMeeting(meeting: MeetingRecord | undefined): boolean {
  return meeting?.status === "completed" || meeting?.status === "stopped_during_meeting";
}

function assertMeetingControlKey(req: Request, stored: StoredInterview): boolean {
  return readBearerToken(req) === stored.projection.meetingControlKey;
}

function respondError(res: Response, status: number, errorCode: string): void {
  res.status(status).json({ errorCode });
}

function shouldRejectTooEarly(stored: StoredInterview, now = Date.now()): boolean {
  const meetingAtMs = new Date(stored.projection.meetingAt).getTime();
  return Number.isFinite(meetingAtMs) && now < meetingAtMs;
}

type AgentRtmpUrlSource =
  | "body.agentRTMPURL"
  | "rawPayload.agentRTMPURL"
  | "rawPayload.livekitIngressRtmpUrl"
  | "rawPayload.livekitRtmpUrl"
  | "rawPayload.ingressUrl"
  | "rawPayload.liveKitIngressUrl"
  | "missing";

function resolveAgentRtmpUrl(input: { agentRTMPURL?: string }, stored: StoredInterview): { url: string; source: AgentRtmpUrlSource } {
  const fromBody = typeof input.agentRTMPURL === "string" ? input.agentRTMPURL.trim() : "";
  if (fromBody) {
    return { url: fromBody, source: "body.agentRTMPURL" };
  }

  const raw = stored.rawPayload;
  const candidates: Array<{ source: AgentRtmpUrlSource; value?: string | null }> = [
    { source: "rawPayload.agentRTMPURL", value: raw.agentRTMPURL },
    { source: "rawPayload.livekitIngressRtmpUrl", value: raw.livekitIngressRtmpUrl },
    { source: "rawPayload.livekitRtmpUrl", value: raw.livekitRtmpUrl },
    { source: "rawPayload.ingressUrl", value: raw.ingressUrl },
    { source: "rawPayload.liveKitIngressUrl", value: raw.liveKitIngressUrl }
  ];
  for (const candidate of candidates) {
    const value = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (value) {
      return { url: value, source: candidate.source };
    }
  }

  return { url: "", source: "missing" };
}

function rtmpIngressStatusFor(input: { rtmp: string; ttsActive?: boolean }): string {
  if (!input.rtmp) {
    return "missing_agent_rtmp_url";
  }
  if (!rtmpTtsSessionManager.isEnabled()) {
    return "rtmp_ingress_disabled";
  }
  return input.ttsActive ? "publisher_spawned" : "publisher_not_started";
}

function isRecoverablePublisherSnapshot(snapshot: RtmpTtsSessionSnapshot): boolean {
  return !snapshot.active && (
    snapshot.state === "missing" ||
    snapshot.state === "exited" ||
    snapshot.state === "failed" ||
    snapshot.state === "stopped"
  );
}

function rtmpIngressStatusForSnapshot(input: { rtmp: string; snapshot: RtmpTtsSessionSnapshot }): string {
  if (!input.rtmp) {
    return "missing_agent_rtmp_url";
  }
  if (!rtmpTtsSessionManager.isEnabled()) {
    return "rtmp_ingress_disabled";
  }
  if (input.snapshot.state === "recovered") {
    return "publisher_recovered";
  }
  if (input.snapshot.active) {
    return "publisher_spawned";
  }
  return `publisher_${input.snapshot.state}`;
}

type RuntimeHealth = "healthy" | "degraded" | "dead";

function runtimeHealthFor(input: {
  meeting?: MeetingRecord;
  publisher: RtmpTtsSessionSnapshot;
  receiverActive: boolean;
  receiverEnabled: boolean;
}): RuntimeHealth {
  if (!input.meeting || isFinishedMeeting(input.meeting)) {
    return "dead";
  }
  if (!input.publisher.active) {
    return input.meeting.status === "in_meeting" ? "dead" : "degraded";
  }
  if (input.receiverEnabled && !input.receiverActive) {
    return "degraded";
  }
  return "healthy";
}

function numericMeetingIdFromPath(value: string): number | undefined {
  const trimmed = value.trim();
  const match = /^nullxes-meeting-(\d+)$/.exec(trimmed);
  const numeric = match ? Number(match[1]) : /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

/**
 * LiveKit RTMP ingress lifecycle is owned by JobAI / LiveKit contour.
 * Gateway does not create ingress.
 * Gateway only consumes provided agentRTMPURL
 * and publishes AI audio through ffmpeg.
 */
export function createMeetingRouter(
  orchestrator: MeetingOrchestrator,
  deps?: {
    recordings?: StreamRecordingService;
    interviews?: InterviewSyncService;
    runtimeEvents?: RuntimeEventStore;
    controlWsHub?: MeetingControlWsHub;
    avatarRuntime?: AvatarRuntimeSessionManager;
    presence?: MeetingCandidatePresenceTracker;
  }
): express.Router {
  const router = express.Router();

  router.post(
    "/:meetingId/artifacts/assistant-audio",
    express.raw({ type: "*/*", limit: env.ASSISTANT_AUDIO_MAX_BYTES }),
    asyncHandler(async (req: Request, res: Response) => {
      const meetingId = req.params.meetingId;
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream";
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
      if (!bytes.byteLength) {
        throw new HttpError(400, "assistant_audio_empty");
      }
      const saved = await saveAssistantAudioArtifact({ meetingId, bytes, contentType });
      orchestrator.updateRecordingMetadata(meetingId, {
        assistant_audio_url: saved.publicUrlPath,
        assistant_audio_filename: saved.filename,
        assistant_audio_bytes: saved.bytes,
        assistant_audio_content_type: saved.contentType
      });
      logger.info(
        { meetingId, bytes: saved.bytes, filename: saved.filename },
        "assistant audio artifact saved"
      );
      res.status(201).json({
        ok: true,
        artifact: {
          url: saved.publicUrlPath,
          filename: saved.filename,
          bytes: saved.bytes,
          contentType: saved.contentType
        }
      });
    })
  );

  router.post("/start", asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.meetingId === "number") {
      if (!deps?.interviews) {
        respondError(res, 404, "meeting_not_found");
        return;
      }
      const input = parseBody(controlStartMeetingSchema, req.body);
      const stored = deps.interviews.getInterviewByNumericMeetingId(input.meetingId);
      if (!stored) {
        respondError(res, 404, "meeting_not_found");
        return;
      }
      if (!assertMeetingControlKey(req, stored)) {
        respondError(res, 401, "wrong_meeting_control_key");
        return;
      }
      if (isFinishedInterview(stored)) {
        respondError(res, 400, "meeting_already_finished");
        return;
      }
      if (shouldRejectTooEarly(stored)) {
        respondError(res, 400, "too_early");
        return;
      }

      const internalId = internalMeetingId(input.meetingId);
      const resolvedAgentRtmp = resolveAgentRtmpUrl(input, stored);
      const rtmp = resolvedAgentRtmp.url;
      logger.info(
        {
          meetingId: input.meetingId,
          jobAiId: stored.jobAiId,
          agentRTMPURLSource: resolvedAgentRtmp.source,
          hasAgentRTMPURL: rtmp.length > 0,
          rtmp: rtmp.length > 0 ? truncateRtmpUrl(rtmp) : undefined
          
        },
        "control meeting start: resolved agent RTMP URL"
      );
      if (rtmp.length === 0) {
        logger.warn(
          {
            event: "missing_agent_rtmp_url",
            meetingId: input.meetingId,
            jobAiId: stored.jobAiId,
            source: resolvedAgentRtmp.source
          },
          "control meeting start rejected without agent RTMP URL"
        );
        res.status(400).json({
          errorCode: "missing_agent_rtmp_url",
          message: "agentRTMPURL is required for RTMP ingress lifecycle"
        });
        return;
      }

      const existingMeeting = orchestrator.tryGetMeeting(internalId);
      if (existingMeeting && !isFinishedMeeting(existingMeeting)) {
        const publisherSnapshot = rtmpTtsSessionManager.getSnapshot(input.meetingId);
        if (isRecoverablePublisherSnapshot(publisherSnapshot)) {
          if (!rtmpTtsSessionManager.isEnabled()) {
            respondError(res, 400, "rtmp_publish_failed");
            return;
          }
          try {
            registerRtmpTtsTapIfRealtime(internalId, input.meetingId);
            await rtmpTtsSessionManager.start({
              meetingId: input.meetingId,
              rtmpUrl: rtmp,
              recovered: true
            });
            flushRtmpTtsTapIfRealtime(input.meetingId, "publisher_recovered");
            startStagedVoiceForMeeting({
              internalId,
              numericMeetingId: input.meetingId,
              stored,
              controlWsHub: deps.controlWsHub,
              runtimeEvents: deps.runtimeEvents
            });
            rtmpIngressSmokeLoop.start(input.meetingId, "publisher_recovered");
            const recoveredSnapshot = rtmpTtsSessionManager.getSnapshot(input.meetingId);
            const receiverActive = false;
            const recoveredRuntimeHealth = runtimeHealthFor({
              meeting: existingMeeting,
              publisher: recoveredSnapshot,
              receiverActive,
              receiverEnabled: ENABLE_RTMP_RECEIVER
            });
            const previousRecoveryCount =
              typeof existingMeeting.metadata?.publisherRecoveryCount === "number"
                ? existingMeeting.metadata.publisherRecoveryCount
                : 0;
            orchestrator.updateMeetingMetadata(internalId, {
              agentRTMPURL: rtmp,
              agentRTMPURLSource: resolvedAgentRtmp.source,
              rtmpIngressStatus: "publisher_recovered",
              publisherRecoveredAt: new Date().toISOString(),
              publisherRecoveryCount: previousRecoveryCount + 1,
              lastRecoveredPublisherState: publisherSnapshot.state,
              runtimeHealth: recoveredRuntimeHealth
            });
            void deps.runtimeEvents?.append({
              type: "meeting.control.started",
              meetingId: internalId,
              jobAiId: stored.jobAiId,
              actor: "nullxes_control_api",
              payload: {
                numericMeetingId: input.meetingId,
                agentRTMPURLSource: resolvedAgentRtmp.source,
                rtmpIngressStatus: "publisher_recovered",
                previousPublisherState: publisherSnapshot.state,
                publisherRecoveryCount: previousRecoveryCount + 1,
                agentRTMPURL: rtmp
              }
            }).catch(() => undefined);
            res.status(200).json({
              state: "publisher_recovered" as const,
              meetingId: internalId,
              numericMeetingId: input.meetingId,
              status: existingMeeting.status,
              runtimeHealth: recoveredRuntimeHealth,
              publisherState: recoveredSnapshot.state,
              publisherActive: recoveredSnapshot.active,
              receiverActive,
              agentReceiverRTMPURL: STUB_AGENT_RECEIVER_RTMP_URL,
              rtmpIngressStatus: "publisher_recovered",
              agentRTMPURLSource: resolvedAgentRtmp.source,
              pid: recoveredSnapshot.pid,
              startedAt: recoveredSnapshot.startedAt
            });
            return;
          } catch (err: unknown) {
            unregisterRtmpTtsTapIfRealtime(internalId);
            logger.warn(
              { meetingId: input.meetingId, internalId, error: err instanceof Error ? err.message : String(err) },
              "rtmp tts recovery failed"
            );
            respondError(res, 400, "rtmp_publish_failed");
            return;
          }
        }
        const existingIngressStatus = rtmpIngressStatusForSnapshot({ rtmp, snapshot: publisherSnapshot });
        const receiverActive = false;
        const runtimeHealth = runtimeHealthFor({
          meeting: existingMeeting,
          publisher: publisherSnapshot,
          receiverActive,
          receiverEnabled: ENABLE_RTMP_RECEIVER
        });
        const existingAgentRtmpUrlSource =
          typeof existingMeeting.metadata?.agentRTMPURLSource === "string"
            ? existingMeeting.metadata.agentRTMPURLSource
            : resolvedAgentRtmp.source;
        res.status(200).json({
          state: "meeting_already_started" as const,
          meetingId: internalId,
          numericMeetingId: input.meetingId,
          status: existingMeeting.status,
          runtimeHealth,
          publisherState: publisherSnapshot.state,
          agentReceiverRTMPURL: STUB_AGENT_RECEIVER_RTMP_URL,
          receiverActive,
          rtmpIngressStatus: existingIngressStatus,
          agentRTMPURLSource: existingAgentRtmpUrlSource
        });
        return;
      }
      if (isFinishedMeeting(existingMeeting)) {
        respondError(res, 400, "meeting_already_finished");
        return;
      }

      const metadata: Record<string, unknown> = {
        numericMeetingId: input.meetingId,
        jobAiId: stored.jobAiId,
        source: "nullxes_control_api",
        interviewContext: {
          jobTitle: stored.rawPayload.jobTitle,
          vacancyText: stored.rawPayload.vacancyText,
          companyName: stored.rawPayload.companyName,
          candidateName: `${stored.projection.candidateFirstName} ${stored.projection.candidateLastName}`.trim(),
          questions: stored.rawPayload.specialty?.questions ?? []
        }
      };
      metadata.agentRTMPURLSource = resolvedAgentRtmp.source;
      metadata.rtmpIngressStatus = rtmpIngressStatusFor({ rtmp });
      metadata.agentRTMPURL = rtmp;

      let agentReceiverRTMPURL = STUB_AGENT_RECEIVER_RTMP_URL;
      metadata.agentReceiverRTMPURL = agentReceiverRTMPURL;

      if (ENABLE_RTMP_RECEIVER && rtmpSttBridge.isEnabled()) {
        try {
          const out = await rtmpSttBridge.start({
            numericMeetingId: input.meetingId,
            internalMeetingId: internalId,
            controlWsHub: deps.controlWsHub,
            runtimeEvents: deps.runtimeEvents,
            dialogueContext: dialogueContextFromStored(stored)
          });
          agentReceiverRTMPURL = out.agentReceiverRTMPURL;
          metadata.agentReceiverRTMPURL = agentReceiverRTMPURL;
        } catch (err: unknown) {
          logger.warn(
            { err, meetingId: input.meetingId, error: err instanceof Error ? err.message : String(err) },
            "rtmp receiver/stt start failed"
          );
          respondError(res, 400, "rtmp_receiver_not_ready");
          return;
        }
      }

      const result = orchestrator.startMeeting({
        meetingId: internalId,
        triggerSource: "nullxes_control_api",
        metadata
      });

      if (!rtmpTtsSessionManager.isEnabled()) {
        await rtmpSttBridge.stop(input.meetingId);
        orchestrator.stopMeeting(internalId, {
          reason: "manual_stop",
          finalStatus: "stopped_during_meeting",
          metadata: {
            numericMeetingId: input.meetingId,
            source: "nullxes_control_api",
            stopReason: "rtmp_publish_failed"
          }
        });
        respondError(res, 400, "rtmp_publish_failed");
        return;
      }
      try {
        registerRtmpTtsTapIfRealtime(internalId, input.meetingId);
        await rtmpTtsSessionManager.start({
          meetingId: input.meetingId,
          rtmpUrl: rtmp
        });
        flushRtmpTtsTapIfRealtime(input.meetingId, "publisher_spawned");
        startStagedVoiceForMeeting({
          internalId,
          numericMeetingId: input.meetingId,
          stored,
          controlWsHub: deps.controlWsHub,
          runtimeEvents: deps.runtimeEvents
        });
        if (env.VOICE_MODE === "realtime") {
          rtmpIngressSmokeLoop.start(input.meetingId, "publisher_spawned");
        }
        const publisherSnapshot = rtmpTtsSessionManager.getSnapshot(input.meetingId);
        const receiverActive = false;
        const runtimeHealth = runtimeHealthFor({
          meeting: result.meeting,
          publisher: publisherSnapshot,
          receiverActive,
          receiverEnabled: ENABLE_RTMP_RECEIVER
        });
        metadata.rtmpIngressStatus = "publisher_spawned";
        orchestrator.updateMeetingMetadata(internalId, {
          rtmpIngressStatus: "publisher_spawned",
          runtimeHealth
        });
      } catch (err: unknown) {
        unregisterRtmpTtsTapIfRealtime(internalId);
        stagedVoiceTurnRuntime.close(internalId);
        await rtmpSttBridge.stop(input.meetingId);
        orchestrator.stopMeeting(internalId, {
          reason: "manual_stop",
          finalStatus: "stopped_during_meeting",
          metadata: {
            numericMeetingId: input.meetingId,
            source: "nullxes_control_api",
            stopReason: "rtmp_publish_failed"
          }
        });
        metadata.rtmpIngressStatus = "publisher_start_failed";
        logger.warn(
          { meetingId: input.meetingId, internalId, error: err instanceof Error ? err.message : String(err) },
          "rtmp tts start failed after meeting start — rolled back"
        );
        respondError(res, 400, "rtmp_publish_failed");
        return;
      }

      deps.presence?.markSessionStarted(input.meetingId);
      deps.interviews.attachSession(stored.jobAiId, {
        meetingId: internalId,
        nullxesStatus: "in_meeting"
      });
      void deps.interviews.transitionStatus(stored.jobAiId, "in_meeting").catch((error: unknown) => {
        logger.warn(
          { jobAiId: stored.jobAiId, meetingId: input.meetingId, error: error instanceof Error ? error.message : String(error) },
          "control meeting start: failed to transition JobAI status to in_meeting"
        );
      });
      void deps.runtimeEvents?.append({
        type: "meeting.control.started",
        meetingId: internalId,
        jobAiId: stored.jobAiId,
        actor: "nullxes_control_api",
        payload: {
          numericMeetingId: input.meetingId,
          agentRTMPURLSource: resolvedAgentRtmp.source,
          rtmpIngressStatus: metadata.rtmpIngressStatus,
          ...(rtmp.length > 0 ? { agentRTMPURL: rtmp } : {}),
          ...(agentReceiverRTMPURL ? { agentReceiverRTMPURL } : {})
        }
      }).catch(() => undefined);
      res.status(200).json({
        state: "meeting_started" as const,
        meetingId: internalId,
        numericMeetingId: input.meetingId,
        status: result.meeting.status,
        runtimeHealth: result.meeting.metadata.runtimeHealth,
        publisherState: rtmpTtsSessionManager.getSnapshot(input.meetingId).state,
        publisherActive: rtmpTtsSessionManager.getSnapshot(input.meetingId).active,
        receiverActive: false,
        agentReceiverRTMPURL,
        agentRTMPURLSource: resolvedAgentRtmp.source,
        rtmpIngressStatus: metadata.rtmpIngressStatus
      });
      return;
    }

    const input = parseBody(startMeetingSchema, req.body);
    const metadata = (input.metadata ?? {}) as Record<string, unknown>;
    const interviewContext = (metadata.interviewContext ?? {}) as Record<string, unknown>;
    const contextProbe = {
      hasJobTitle: typeof interviewContext.jobTitle === "string" && interviewContext.jobTitle.trim().length > 0,
      hasVacancyText: typeof interviewContext.vacancyText === "string" && interviewContext.vacancyText.trim().length > 0,
      hasCompanyName: typeof interviewContext.companyName === "string" && interviewContext.companyName.trim().length > 0,
      questionCount: Array.isArray(interviewContext.questions) ? interviewContext.questions.length : 0
    };

    logger.info(
      {
        requestId: req.requestId,
        meetingId: input.meetingId,
        triggerSource: input.triggerSource,
        contextProbe
      },
      "meeting start received with interview context probe"
    );

    const result = orchestrator.startMeeting(input);
    void deps?.avatarRuntime?.startForMeeting({
      meetingId: input.meetingId,
      sessionId: input.sessionId ?? input.meetingId,
      numericMeetingId:
        typeof input.metadata?.numericMeetingId === "number" ? input.metadata.numericMeetingId : undefined
    }).catch((error: unknown) => {
      logger.warn(
        { meetingId: input.meetingId, error: error instanceof Error ? error.message : String(error) },
        "avatar runtime start failed after meeting start"
      );
    });
    res.status(201).json(result);
  }));

  router.post("/stop", asyncHandler(async (req: Request, res: Response) => {
    if (!deps?.interviews) {
      respondError(res, 404, "meeting_not_found");
      return;
    }
    const input = parseBody(controlStopMeetingSchema, req.body);
    const stored = deps.interviews.getInterviewByNumericMeetingId(input.meetingId);
    if (!stored) {
      respondError(res, 404, "meeting_not_found");
      return;
    }
    if (!assertMeetingControlKey(req, stored)) {
      respondError(res, 401, "wrong_meeting_control_key");
      return;
    }
    if (isFinishedInterview(stored)) {
      respondError(res, 400, "meeting_already_finished");
      return;
    }

    const internalId = internalMeetingId(input.meetingId);
    const existingMeeting = orchestrator.tryGetMeeting(internalId);
    if (!existingMeeting) {
      respondError(res, 404, "meeting_not_found");
      return;
    }
    if (isFinishedMeeting(existingMeeting)) {
      respondError(res, 400, "meeting_already_finished");
      return;
    }

    const result = orchestrator.stopMeeting(internalId, {
      reason: "manual_stop",
      finalStatus: "stopped_during_meeting",
      metadata: {
        stopReason: input.stopReason,
        numericMeetingId: input.meetingId,
        jobAiId: stored.jobAiId,
        source: "nullxes_control_api"
      }
    });
    deps.interviews.attachSession(stored.jobAiId, {
      meetingId: internalId,
      nullxesStatus: "stopped_during_meeting"
    });
    void deps.interviews.transitionStatus(stored.jobAiId, "stopped_during_meeting").catch((error: unknown) => {
      logger.warn(
        { jobAiId: stored.jobAiId, meetingId: input.meetingId, stopReason: input.stopReason, error: error instanceof Error ? error.message : String(error) },
        "control meeting stop: failed to transition JobAI status to stopped_during_meeting"
      );
    });
    void deps.runtimeEvents?.append({
      type: "meeting.control.stopped",
      meetingId: internalId,
      jobAiId: stored.jobAiId,
      actor: "nullxes_control_api",
      payload: { numericMeetingId: input.meetingId, stopReason: input.stopReason }
    }).catch(() => undefined);
    rtmpIngressSmokeLoop.stop(input.meetingId, "meeting_stopped");
    unregisterRtmpTtsTapIfRealtime(internalId);
    stagedVoiceTurnRuntime.close(internalId);
    await rtmpTtsSessionManager.stop(input.meetingId);
    await rtmpSttBridge.stop(input.meetingId);
    deps.avatarRuntime?.stop(internalId, input.stopReason);
    deps.controlWsHub?.closeMeeting(input.meetingId, "meeting_stopped");
    res.status(200).json({
      ok: true,
      meetingId: internalId,
      numericMeetingId: input.meetingId,
      status: result.meeting.status,
      stopReason: input.stopReason
    });
  }));

  router.post("/:meetingId/stop", asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody<StopMeetingInput>(stopMeetingSchema, req.body);
    const result = orchestrator.stopMeeting(req.params.meetingId, input);
    deps?.avatarRuntime?.stop(req.params.meetingId, input.reason);
    res.status(200).json(result);
  }));

  router.post("/:meetingId/fail", asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody<FailMeetingInput>(failMeetingSchema, req.body);
    const result = orchestrator.failMeeting(req.params.meetingId, input);
    deps?.avatarRuntime?.stop(req.params.meetingId, input.reason);
    res.status(200).json(result);
  }));

  router.get("/:meetingId/rtmp/status", (req: Request, res: Response) => {
    let numericMeetingId = numericMeetingIdFromPath(req.params.meetingId);
    let meetingId = numericMeetingId ? internalMeetingId(numericMeetingId) : req.params.meetingId;
    let meeting = orchestrator.tryGetMeeting(meetingId);
    if (!numericMeetingId && typeof meeting?.metadata?.numericMeetingId === "number") {
      numericMeetingId = meeting.metadata.numericMeetingId;
    }
    if (numericMeetingId) {
      meetingId = internalMeetingId(numericMeetingId);
      meeting = meeting ?? orchestrator.tryGetMeeting(meetingId);
    }
    if (!numericMeetingId) {
      res.status(400).json({ errorCode: "invalid_meeting_id" });
      return;
    }

    const stored = deps?.interviews?.getInterviewByNumericMeetingId(numericMeetingId);
    if (!stored && !meeting) {
      res.status(404).json({ errorCode: "meeting_not_found" });
      return;
    }

    const metadataSource =
      typeof meeting?.metadata?.agentRTMPURLSource === "string"
        ? (meeting.metadata.agentRTMPURLSource as AgentRtmpUrlSource)
        : "missing";
    const metadataRtmp = typeof meeting?.metadata?.agentRTMPURL === "string" ? meeting.metadata.agentRTMPURL.trim() : "";
    const agentRtmp = stored ? resolveAgentRtmpUrl({}, stored) : { url: metadataRtmp, source: metadataSource };
    const publisher = rtmpTtsSessionManager.getSnapshot(numericMeetingId);
    const receiverActive = false;
    const rtmpIngressStatus = rtmpIngressStatusForSnapshot({ rtmp: agentRtmp.url, snapshot: publisher });
    const runtimeHealth = runtimeHealthFor({
      meeting,
      publisher,
      receiverActive,
      receiverEnabled: ENABLE_RTMP_RECEIVER
    });

    res.status(200).json({
      meetingId,
      numericMeetingId,
      runtimeHealth,
      publisherActive: publisher.active,
      receiverActive,
      meetingPersistedState: meeting?.status ?? null,
      publisherState: publisher.state,
      rtmpIngressStatus,
      pid: publisher.pid ?? null,
      startedAt: publisher.startedAt ?? null,
      exitedAt: publisher.exitedAt ?? null,
      exitCode: publisher.exitCode ?? null,
      agentRTMPURLSource: agentRtmp.source,
      hasAgentRTMPURL: agentRtmp.url.length > 0,
      agentRTMPURL: agentRtmp.url.length > 0 ? truncateRtmpUrl(agentRtmp.url) : null,
      agentReceiverRTMPURL: STUB_AGENT_RECEIVER_RTMP_URL,
      publisher
    });
  });

  router.get("/ops/rtmp/:meetingId", (req: Request, res: Response) => {
    if (!deps?.interviews) {
      res.status(503).json({ errorCode: "interview_sync_not_configured" });
      return;
    }
    const numericMeetingId = Number(req.params.meetingId);
    if (!Number.isSafeInteger(numericMeetingId) || numericMeetingId <= 0) {
      res.status(400).json({ errorCode: "invalid_meeting_id" });
      return;
    }

    const stored = deps.interviews.getInterviewByNumericMeetingId(numericMeetingId);
    if (!stored) {
      res.status(404).json({ errorCode: "meeting_not_found" });
      return;
    }

    const internalId = internalMeetingId(numericMeetingId);
    const meeting = orchestrator.tryGetMeeting(internalId);
    const agentRtmp = resolveAgentRtmpUrl({}, stored);
    const tts = rtmpTtsSessionManager.getSnapshot(numericMeetingId);
    const receiverActive = false;
    const runtimeHealth = runtimeHealthFor({
      meeting,
      publisher: tts,
      receiverActive,
      receiverEnabled: ENABLE_RTMP_RECEIVER
    });

    res.status(200).json({
      meetingId: internalId,
      numericMeetingId,
      jobAiId: stored.jobAiId,
      jobAiStatus: stored.rawPayload.status,
      nullxesStatus: stored.projection.nullxesStatus,
      meetingAt: stored.projection.meetingAt,
      runtimeHealth,
      publisherActive: tts.active,
      receiverActive,
      meetingPersistedState: meeting?.status ?? null,
      publisherState: tts.state,
      gatewayMeeting: meeting
        ? {
            status: meeting.status,
            triggerSource: meeting.triggerSource,
            metadata: {
              rtmpIngressStatus: meeting.metadata?.rtmpIngressStatus,
              agentRTMPURLSource: meeting.metadata?.agentRTMPURLSource,
              hasAgentRTMPURL: typeof meeting.metadata?.agentRTMPURL === "string" && meeting.metadata.agentRTMPURL.length > 0,
              hasAgentReceiverRTMPURL: false,
              strictChtzReceiverDisabled: !ENABLE_RTMP_RECEIVER
            }
          }
        : null,
      rtmp: {
        ingress: {
          enabled: rtmpTtsSessionManager.isEnabled(),
          status: tts.status,
          state: tts.state,
          active: tts.active,
          rtmpIngressStatus: rtmpIngressStatusForSnapshot({ rtmp: agentRtmp.url, snapshot: tts }),
          agentRTMPURLSource: agentRtmp.source,
          hasAgentRTMPURL: agentRtmp.url.length > 0,
          agentRTMPURL: agentRtmp.url.length > 0 ? truncateRtmpUrl(agentRtmp.url) : null,
          publisher: tts
        },
        receiver: {
          enabled: ENABLE_RTMP_RECEIVER,
          active: receiverActive,
          agentReceiverRTMPURL: STUB_AGENT_RECEIVER_RTMP_URL
        }
      },
      controlWsConnections: deps.controlWsHub?.getConnectionCount(numericMeetingId) ?? null
    });
  });

  router.get("/:meetingId", (req: Request, res: Response) => {
    const result = orchestrator.getMeeting(req.params.meetingId);
    res.status(200).json(result);
  });

  router.post("/:meetingId/openai/voice", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(openAiVoiceSchema, req.body ?? {});
    const voice = typeof input.voice === "string" ? input.voice.trim() : "";
    orchestrator.updateMeetingMetadata(meetingId, {
      openai_realtime_voice: voice.length > 0 ? voice : null
    });
    res.status(200).json({ ok: true, meetingId, voice: voice.length > 0 ? voice : null });
  }));

  router.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      meetings: orchestrator.listMeetings()
    });
  });

  // ---------------- candidate admission ----------------

  router.get("/:meetingId/admission/candidate", (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    const participantIdRaw = req.query.participantId;
    const participantId = typeof participantIdRaw === "string" ? participantIdRaw : undefined;
    const view = orchestrator.getCandidateAdmission(meetingId, participantId);
    res.status(200).json(view);
  });

  router.post("/:meetingId/admission/candidate/acquire", (req: Request, res: Response) => {
    const input = parseBody(admissionAcquireSchema, req.body);
    const result = orchestrator.acquireCandidateAdmission(req.params.meetingId, input);
    if (result.granted) {
      res.status(200).json(result.status);
      return;
    }
    res.status(423).json({
      error: "AdmissionAwaitingApproval",
      message: "Кандидат уже подключен, ожидайте подтверждение.",
      code: "admission.awaiting_approval",
      ...result.status
    });
  });

  router.post("/:meetingId/admission/candidate/release", (req: Request, res: Response) => {
    const input = parseBody(admissionReleaseSchema, req.body);
    const result = orchestrator.releaseCandidateAdmission(req.params.meetingId, input);
    res.status(200).json({
      released: result.released,
      owner: result.status.owner,
      pending: result.status.pending,
      meetingId: result.status.meetingId,
      rejoinWindowMs: result.status.rejoinWindowMs,
      ownerActive: result.status.ownerActive,
      canCurrentParticipantRejoin: result.status.canCurrentParticipantRejoin
    });
  });

  router.post("/:meetingId/admission/candidate/decision", (req: Request, res: Response) => {
    const input = parseBody(admissionDecisionSchema, req.body);
    const result = orchestrator.decideCandidateAdmission(req.params.meetingId, input);
    res.status(200).json({
      action: result.action,
      granted: result.granted,
      owner: result.status.owner,
      pending: result.status.pending,
      meetingId: result.status.meetingId,
      rejoinWindowMs: result.status.rejoinWindowMs,
      ownerActive: result.status.ownerActive,
      canCurrentParticipantRejoin: result.status.canCurrentParticipantRejoin
    });
  });

  router.get("/:meetingId/recording", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const callType = typeof req.query.callType === "string" && req.query.callType.trim().length > 0
      ? req.query.callType.trim()
      : undefined;
    const callId = typeof req.query.callId === "string" && req.query.callId.trim().length > 0
      ? req.query.callId.trim()
      : meetingId;

    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      res.status(200).json({
        configured: false,
        state: "idle",
        callType: callType ?? "default",
        callId
      });
      return;
    }

    const snapshot = await deps.recordings.getSnapshot(callId);
    const withUrl = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId,
      stream_recording_url: withUrl?.url,
      stream_recording_filename: withUrl?.filename
    });
    res.status(200).json({
      configured: true,
      ...snapshot,
      callType: callType ?? snapshot.callType
    });
  }));

  router.post("/:meetingId/recording/start", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingStartSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.start(callId);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: input.callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId
    });
    res.status(202).json({ configured: true, ...snapshot, callType: input.callType ?? snapshot.callType });
  }));

  router.post("/:meetingId/recording/stop", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingStartSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.stop(callId);
    const withUrl = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: input.callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId,
      stream_recording_url: withUrl?.url,
      stream_recording_filename: withUrl?.filename
    });
    res.status(202).json({ configured: true, ...snapshot, callType: input.callType ?? snapshot.callType });
  }));

  router.get("/:meetingId/recording/download", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const callId = typeof req.query.callId === "string" && req.query.callId.trim().length > 0
      ? req.query.callId.trim()
      : meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.getSnapshot(callId);
    const asset = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    if (!asset?.url) {
      res.status(202).json({
        state: snapshot.state,
        callType: snapshot.callType,
        callId: snapshot.callId,
        ready: false,
        message: "Recording is processing. Retry download shortly."
      });
      return;
    }
    res.status(200).json({
      state: snapshot.state,
      callType: snapshot.callType,
      callId: snapshot.callId,
      asset
    });
  }));

  router.post("/:meetingId/recording/sync-jobai", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingSyncSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    if (!deps.interviews) {
      throw new HttpError(503, "Interview sync service is not configured");
    }
    const snapshot = await deps.recordings.getSnapshot(callId);
    const latest = snapshot.assets.find((asset) => Boolean(asset.url));
    const recording = deps.interviews.attachRecording(input.jobAiId, {
      state: snapshot.state,
      callType: input.callType ?? snapshot.callType,
      callId: snapshot.callId,
      activeRecordingId: snapshot.activeRecordingId,
      latestDownloadUrl: latest?.url,
      latestFilename: latest?.filename,
      codec: latest?.codec,
      container: latest?.container
    });
    logger.info(
      {
        meetingId,
        jobAiId: input.jobAiId,
        recordingState: snapshot.state,
        callId: snapshot.callId
      },
      "jobai recording sync projected in interview store"
    );
    res.status(200).json({
      ok: true,
      projection: recording.projection.recording,
      snapshot
    });
  }));

  router.use(((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    if (error instanceof StreamRecordingStateError) {
      if (error.code === "processing") {
        next(new HttpError(202, error.message, { code: error.code }));
        return;
      }
      if (error.code === "not_recording" || error.code === "already_recording") {
        next(new HttpError(409, error.message, { code: error.code }));
        return;
      }
      if (error.code === "not_found") {
        next(new HttpError(404, error.message, { code: error.code }));
        return;
      }
    }
    next(error);
  }) as express.ErrorRequestHandler);

  return router;
}
