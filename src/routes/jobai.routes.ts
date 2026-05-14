import express, { type Request, type Response } from "express";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { InterviewSyncService } from "../services/interviewSyncService";
import { JobAiClient } from "../services/jobaiClient";

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function readIngestSecretFromRequest(req: Request): string | undefined {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (auth) {
    const trimmed = auth.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (bearer?.[1]) {
      return bearer[1].trim();
    }
    return trimmed;
  }
  return req.header("x-jobai-ingest-secret") ?? undefined;
}

function assertIngestSecret(req: Request): void {
  if (!env.JOBAI_INGEST_SECRET) {
    return;
  }

  const provided = readIngestSecretFromRequest(req);
  if (provided !== env.JOBAI_INGEST_SECRET) {
    throw new HttpError(401, "Invalid ingest secret");
  }
}

function buildInterviewInviteUrl(inviteToken: string): string {
  return `${env.NULLXES_INTERVIEW_FRONTEND_BASE_URL.replace(/\/+$/, "")}/join/${inviteToken}`;
}

function normalizePromptPayload(payload: unknown): {
  mainPrompt: string | null;
  idkAnswers: string[];
  greetingSpeech: string;
  finalSpeech: string;
  source: string;
} {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const mainPrompt =
    typeof record.mainPrompt === "string" && record.mainPrompt.trim().length > 0
      ? record.mainPrompt.trim()
      : null;
  const idkAnswers = Array.isArray(record.idkAnswers)
    ? record.idkAnswers.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const greetingSpeech = typeof record.greetingSpeech === "string" ? record.greetingSpeech : "";
  const finalSpeech = typeof record.finalSpeech === "string" ? record.finalSpeech : "";
  const source = typeof record.source === "string" && record.source.trim().length > 0 ? record.source.trim() : "jobai_settings";
  return { mainPrompt, idkAnswers, greetingSpeech, finalSpeech, source };
}

export function createJobAiRouter(service: InterviewSyncService, jobAiClient: JobAiClient): express.Router {
  const router = express.Router();

  /** Партнёрский контракт JobAI: путь и форма тела не меняются без согласования (отдельно от REST meetings/start на NULLXES). */
  router.post("/webhooks/jobai/interviews", asyncHandler(async (req: Request, res: Response) => {
    assertIngestSecret(req);
    const stored = await service.ingestWebhook(req.body);
    res.status(202).json({
      interview: stored.rawPayload,
      projection: stored.projection,
      candidateUrl: buildInterviewInviteUrl(stored.projection.inviteTokens.candidate),
      spectatorUrl: buildInterviewInviteUrl(stored.projection.inviteTokens.observer),
      adminUrl: buildInterviewInviteUrl(stored.projection.inviteTokens.admin)
    });
  }));

  router.post("/jobai/sync", asyncHandler(async (req: Request, res: Response) => {
    const skip = typeof req.body?.skip === "number" ? req.body.skip : 0;
    const take = typeof req.body?.take === "number" ? req.body.take : 20;
    const result = await service.synchronize(skip, take);
    res.status(200).json(result);
  }));

  /**
   * Prompt snapshot webhook for JobAI side.
   * Security: same ingest secret contract as interview create/update webhook.
   */
  /** Партнёрский контракт JobAI (тот же префикс `/webhooks/jobai/*`, что и interviews). */
  router.post("/webhooks/jobai/prompt/current", asyncHandler(async (req: Request, res: Response) => {
    assertIngestSecret(req);

    if (!jobAiClient.isConfigured()) {
      res.status(200).json({
        primaryField: "mainPrompt",
        promptVersion: "gateway_fallback_v1",
        source: "gateway_fallback",
        hasOverridePrompt: false,
        mainPrompt: null,
        legacyFields: {
          idkAnswers: "compat",
          greetingSpeech: "compat",
          finalSpeech: "compat"
        },
        idkAnswers: [],
        greetingSpeech: "",
        finalSpeech: "",
        note: "JobAI settings API is not configured; runtime prompt is composed inside frontend from interview context."
      });
      return;
    }

    try {
      const payload = await jobAiClient.getSettings();
      const normalized = normalizePromptPayload(payload);
      res.status(200).json({
        primaryField: "mainPrompt",
        promptVersion: "jobai_hr_v3",
        source: normalized.source,
        hasOverridePrompt: Boolean(normalized.mainPrompt),
        mainPrompt: normalized.mainPrompt,
        legacyFields: {
          idkAnswers: "compat",
          greetingSpeech: "compat",
          finalSpeech: "compat"
        },
        idkAnswers: normalized.idkAnswers,
        greetingSpeech: normalized.greetingSpeech,
        finalSpeech: normalized.finalSpeech,
        syncedAt: new Date().toISOString()
      });
    } catch (error) {
      res.status(200).json({
        primaryField: "mainPrompt",
        promptVersion: "gateway_fallback_v1",
        source: "jobai_unavailable_fallback",
        hasOverridePrompt: false,
        mainPrompt: null,
        legacyFields: {
          idkAnswers: "compat",
          greetingSpeech: "compat",
          finalSpeech: "compat"
        },
        idkAnswers: [],
        greetingSpeech: "",
        finalSpeech: "",
        note: "JobAI settings endpoint is temporarily unavailable.",
        error: error instanceof Error ? error.message : "unknown_error"
      });
    }
  }));

  return router;
}
