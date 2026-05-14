import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { serializeInterviewDetail, serializeInterviewListItem } from "../services/interviewSerialization";
import { buildInterviewGetByTokenPayload } from "../services/interviewInviteResponse";
import { InterviewSyncService } from "../services/interviewSyncService";
import type { JobAiInterviewStatus, StoredInterview } from "../types/interview";

const statusSchema = z.object({
  status: z.enum([
    "pending",
    "received",
    "in_meeting",
    "completed",
    "stopped_during_meeting",
    "canceled",
    "meeting_not_started"
  ])
});

const sessionLinkSchema = z.object({
  meetingId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  nullxesStatus: z.enum(["idle", "in_meeting", "completed", "stopped_during_meeting", "failed"]).optional()
});

const prototypeFioSchema = z.object({
  fullName: z.string().max(500)
});

const inviteTokenLookupSchema = z.object({
  inviteToken: z.string().regex(/^[A-Za-z0-9]{10}$/)
});

const FINISHED_JOBAI_STATUSES = new Set<JobAiInterviewStatus>([
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

function parseIntegerParam(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return parsed;
}

function parseIntegerQuery(value: unknown, fallback: number): number {
  if (typeof value === "undefined") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, "Invalid pagination arguments");
  }
  return Math.floor(parsed);
}

function readBearerToken(req: Request): string | undefined {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (!auth) {
    return undefined;
  }
  const trimmed = auth.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed) ?? /^Bearer:\s*(.+)$/i.exec(trimmed);
  return bearer?.[1]?.trim();
}

function isFinishedInterview(stored: StoredInterview): boolean {
  return (
    FINISHED_JOBAI_STATUSES.has(stored.rawPayload.status) ||
    stored.projection.nullxesStatus === "completed" ||
    stored.projection.nullxesStatus === "stopped_during_meeting"
  );
}

export function createInterviewsRouter(service: InterviewSyncService): express.Router {
  const router = express.Router();

  router.get("/source/status", (_req: Request, res: Response) => {
    res.status(200).json(service.getIntegrationStatus());
  });

  router.get("/", asyncHandler(async (req: Request, res: Response) => {
    const skip = parseIntegerQuery(req.query.skip, 0);
    const take = parseIntegerQuery(req.query.take, 20);
    const sync = req.query.sync === "1" || req.query.sync === "true";
    const result = await service.listInterviews({ skip, take, sync });
    res.status(200).json({
      interviews: result.interviews.map((entry) => serializeInterviewListItem(entry)),
      count: result.count
    });
  }));

  router.post("/get-by-token", (req: Request, res: Response) => {
    if (!env.NULLXES_INTERVIEW_LOOKUP_AUTH_TOKEN) {
      res.status(503).json({ errorCode: "invite_lookup_not_configured" });
      return;
    }

    const providedToken = readBearerToken(req);
    if (providedToken !== env.NULLXES_INTERVIEW_LOOKUP_AUTH_TOKEN) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }

    const parsed = inviteTokenLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errorCode: "invalid_request" });
      return;
    }

    const resolved = service.getInterviewByInviteToken(parsed.data.inviteToken);
    if (!resolved) {
      res.status(404).json({ errorCode: "interview_not_found" });
      return;
    }

    if (isFinishedInterview(resolved.interview)) {
      res.status(400).json({ errorCode: "interview_already_finished" });
      return;
    }

    const { interview, role } = resolved;
    res.status(200).json(buildInterviewGetByTokenPayload(interview, role));
  });

  router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
    const id = parseIntegerParam(req.params.id, "interview id");
    const forceSync = req.query.sync === "1" || req.query.sync === "true";
    const stored = await service.getInterview(id, forceSync);
    res.status(200).json(serializeInterviewDetail(stored));
  }));

  router.get("/:id/entry-paths", (req: Request, res: Response) => {
    const id = parseIntegerParam(req.params.id, "interview id");
    const paths = service.getEntryPaths(id);
    res.status(200).json({ paths });
  });

  router.post("/:id/status", asyncHandler(async (req: Request, res: Response) => {
    const id = parseIntegerParam(req.params.id, "interview id");
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid status payload", parsed.error.flatten());
    }

    try {
      const updated = await service.transitionStatus(id, parsed.data.status as JobAiInterviewStatus);
      res.status(200).json(serializeInterviewDetail(updated));
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 400) {
        res.status(400).json({
          error: "status_change_failed",
          message: error.message,
          details: error.details
        });
        return;
      }
      throw error;
    }
  }));

  router.post("/:id/session-link", (req: Request, res: Response) => {
    const id = parseIntegerParam(req.params.id, "interview id");
    const parsed = sessionLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid session-link payload", parsed.error.flatten());
    }

    const updated = service.attachSession(id, parsed.data);
    res.status(200).json(serializeInterviewDetail(updated));
  });

  router.post("/:id/prototype-candidate-fio", (req: Request, res: Response) => {
    const id = parseIntegerParam(req.params.id, "interview id");
    const parsed = prototypeFioSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid prototype-candidate-fio payload", parsed.error.flatten());
    }

    const updated = service.setPrototypeCandidateFio(id, parsed.data.fullName);
    res.status(200).json(serializeInterviewDetail(updated));
  });

  return router;
}
