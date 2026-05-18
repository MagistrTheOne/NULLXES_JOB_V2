import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env";
import {
  buildInterviewGetByTokenPayload,
  liveKitRoomNameForNumericMeetingId,
  pickLiveKitIngressHintsFromInterview
} from "../services/interviewInviteResponse";
import { InviteLivekitResponseCache } from "../services/inviteLivekitCache";
import type { InterviewSyncService } from "../services/interviewSyncService";
import type { MeetingCandidatePresenceTracker } from "../services/meetingCandidatePresence";
import type { JobAiInterviewStatus, StoredInterview } from "../types/interview";

const inviteBodySchema = z.object({
  inviteToken: z.string().regex(/^[A-Za-z0-9]{10}$/)
});

const meetingIdBodySchema = z.object({
  meetingId: z.number().int().positive()
});

const deinitBodySchema = meetingIdBodySchema;

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

const FINISHED_JOBAI_STATUSES = new Set<JobAiInterviewStatus>([
  "completed",
  "stopped_during_meeting",
  "canceled",
  "meeting_not_started"
]);

function readBearerToken(req: Request): string | undefined {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (!auth) {
    return undefined;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim()) ?? /^Bearer:\s*(.+)$/i.exec(auth.trim());
  return bearer?.[1]?.trim();
}

function isFinishedInterview(stored: StoredInterview): boolean {
  return (
    FINISHED_JOBAI_STATUSES.has(stored.rawPayload.status) ||
    stored.projection.nullxesStatus === "completed" ||
    stored.projection.nullxesStatus === "stopped_during_meeting"
  );
}

function respondError(res: Response, status: number, errorCode: string): void {
  res.status(status).json({ errorCode });
}

export interface JobaiWebrtcProxyRouterDeps {
  interviews: InterviewSyncService;
  cache: InviteLivekitResponseCache;
  presence: MeetingCandidatePresenceTracker;
  scheduleDeinit: (numericMeetingId: number, stopReason: "candidate_leaved" | "candidate_stopped_ui") => void;
}

export function createJobaiWebrtcProxyRouter(deps: JobaiWebrtcProxyRouterDeps): express.Router {
  const router = express.Router();

  router.post(
    "/get-interview-livekit-data",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = inviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        respondError(res, 400, "invalid_request");
        return;
      }
      const { inviteToken } = parsed.data;

      const cached = deps.cache.get(inviteToken);
      if (cached) {
        res.status(200).json(cached);
        return;
      }

      const resolved = deps.interviews.getInterviewByInviteToken(inviteToken);
      if (!resolved) {
        respondError(res, 404, "interview_not_found");
        return;
      }
      if (isFinishedInterview(resolved.interview)) {
        respondError(res, 400, "interview_already_finished");
        return;
      }

      const basePayload = buildInterviewGetByTokenPayload(resolved.interview, resolved.role);
      const meetingId = resolved.interview.projection.meetingId;
      const roomName = liveKitRoomNameForNumericMeetingId(meetingId);

      const ingressFromPartner = pickLiveKitIngressHintsFromInterview(resolved.interview.rawPayload);
      let liveKitResponse: Record<string, unknown>;
      if (!env.LIVEKIT_URL?.trim()) {
        liveKitResponse = {
          configured: false,
          roomName,
          message: "LIVEKIT_URL is not configured",
          ...(Object.keys(ingressFromPartner).length > 0 ? { ingress: ingressFromPartner } : {})
        };
      } else {
        /**
         * LiveKit RTMP ingress lifecycle is owned by JobAI / LiveKit contour.
         * Gateway does not create ingress.
         * Gateway only consumes provided agentRTMPURL
         * and publishes AI audio through ffmpeg.
         */
        liveKitResponse = {
          configured: true,
          roomName,
          serverUrl: env.LIVEKIT_URL,
          tokenPath: "/livekit/token",
          controlWebSocketPath: `/ws/meeting/${meetingId}`,
          ...(Object.keys(ingressFromPartner).length > 0 ? { ingress: ingressFromPartner } : {})
        };
      }

      const out = { ...basePayload, liveKitResponse };
      deps.cache.set(inviteToken, out);
      res.status(200).json(out);
    })
  );

  router.post(
    "/deinit",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = deinitBodySchema.safeParse(req.body);
      if (!parsed.success) {
        respondError(res, 400, "invalid_request");
        return;
      }
      const { meetingId } = parsed.data;
      const stored = deps.interviews.getInterviewByNumericMeetingId(meetingId);
      if (!stored) {
        respondError(res, 404, "meeting_not_found");
        return;
      }
      const bearer = readBearerToken(req);
      if (!bearer || bearer !== stored.projection.meetingControlKey) {
        respondError(res, 401, "wrong_meeting_control_key");
        return;
      }
      if (isFinishedInterview(stored)) {
        respondError(res, 400, "meeting_already_finished");
        return;
      }

      deps.scheduleDeinit(meetingId, "candidate_stopped_ui");
      deps.presence.markStopped(meetingId);
      res.status(200).end();
    })
  );

  router.post(
    "/meeting/ping-status",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = meetingIdBodySchema.safeParse(req.body);
      if (!parsed.success) {
        respondError(res, 400, "invalid_request");
        return;
      }
      const { meetingId } = parsed.data;
      const stored = deps.interviews.getInterviewByNumericMeetingId(meetingId);
      if (!stored) {
        respondError(res, 404, "meeting_not_found");
        return;
      }
      const bearer = readBearerToken(req);
      if (!bearer || bearer !== stored.projection.meetingControlKey) {
        respondError(res, 401, "wrong_meeting_control_key");
        return;
      }
      if (isFinishedInterview(stored)) {
        respondError(res, 400, "meeting_already_finished");
        return;
      }

      deps.presence.touchPing(meetingId);
      const status = deps.presence.getPingStatus(meetingId);
      res.status(200).json({ status });
    })
  );

  return router;
}
