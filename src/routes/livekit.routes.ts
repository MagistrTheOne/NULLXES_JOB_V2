import express, { type Request, type Response } from "express";
import { z } from "zod";
import { AccessToken } from "livekit-server-sdk";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import type { InMemoryMeetingStore } from "../services/meetingStore";
import type { InterviewSyncService } from "../services/interviewSyncService";

const tokenSchema = z.object({
  meetingId: z.string().min(1),
  identity: z.string().min(1).max(160),
  name: z.string().min(1).max(120).optional(),
  canPublish: z.coerce.boolean().optional().default(true),
  canSubscribe: z.coerce.boolean().optional().default(true),
  canPublishData: z.coerce.boolean().optional().default(true),
  ttlSeconds: z.coerce.number().int().min(30).max(60 * 60 * 12).optional().default(60 * 30)
});

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createLiveKitRouter(deps: {
  meetingStore: InMemoryMeetingStore;
  interviews?: InterviewSyncService;
}): express.Router {
  const router = express.Router();

  router.post(
    "/token",
    asyncHandler(async (req, res) => {
      if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
        throw new HttpError(503, "LiveKit is not configured on this gateway");
      }
      const parsed = tokenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid LiveKit token payload", parsed.error.flatten());
      }
      const input = parsed.data;
      const meeting = deps.meetingStore.getMeeting(input.meetingId);
      const m = /^nullxes-meeting-(\d+)$/.exec(input.meetingId);
      const numericId = m ? Number(m[1]) : NaN;
      const interviewOk =
        Number.isFinite(numericId) && numericId > 0 && deps.interviews
          ? Boolean(deps.interviews.getInterviewByNumericMeetingId(numericId))
          : false;
      if (!meeting && !interviewOk) {
        throw new HttpError(404, `Meeting not found: ${input.meetingId}`);
      }
      const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: input.identity,
        name: input.name
      });
      at.addGrant({
        room: input.meetingId,
        roomJoin: true,
        canPublish: input.canPublish,
        canSubscribe: input.canSubscribe,
        canPublishData: input.canPublishData
      });
      // livekit-server-sdk AccessToken#toJwt() may not accept options in older versions.
      // We set ttl at token construction time via `exp` when supported; fallback to default ttl.
      if (typeof (at as unknown as { ttl?: number }).ttl === "number") {
        (at as unknown as { ttl: number }).ttl = input.ttlSeconds;
      }
      const jwt = await at.toJwt();
      res.status(200).json({ serverUrl: env.LIVEKIT_URL, token: jwt, room: input.meetingId, identity: input.identity });
    })
  );

  return router;
}

