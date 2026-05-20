import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { stagedVoiceTurnRuntime } from "../services/stagedVoiceTurnRuntime";
import type { RuntimeEventStore } from "../services/runtimeEventStore";

/**
 * Orchestrated mic ingest — delegates to staged voice when `VOICE_MODE=staged`.
 */

export interface OrchestratedRealtimeRouterDeps {
  runtimeEvents?: RuntimeEventStore;
}

const startSchema = z.object({
  meetingId: z.string().min(1),
  sessionId: z.string().min(1),
  sampleRateHz: z.number().int().positive().default(16000),
  numericMeetingId: z.number().int().positive().optional()
});

const appendSchema = z.object({
  meetingId: z.string().min(1),
  pcm16: z.string().min(1),
  timestampMs: z.number().int().nonnegative().optional()
});

function parseNumericMeetingId(meetingId: string, explicit?: number): number | undefined {
  if (typeof explicit === "number") {
    return explicit;
  }
  const match = /^nullxes-meeting-(\d+)$/.exec(meetingId);
  return match ? Number(match[1]) : undefined;
}

export function createOrchestratedRealtimeRouter(
  deps: OrchestratedRealtimeRouterDeps
): express.Router {
  const router = express.Router();

  router.post("/orchestrated/start", (req: Request, res: Response) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid start payload", parsed.error.flatten());
    }
    const { meetingId, sessionId, sampleRateHz } = parsed.data;
    const numericMeetingId = parseNumericMeetingId(meetingId, parsed.data.numericMeetingId);
    if (env.VOICE_MODE === "staged" && typeof numericMeetingId === "number") {
      stagedVoiceTurnRuntime.start({
        meetingId,
        sessionId,
        numericMeetingId,
        sampleRateHz,
        runtimeEvents: deps.runtimeEvents
      });
    }
    void deps.runtimeEvents?.append({
      type: "realtime.orchestrated.started",
      meetingId,
      sessionId,
      actor: "frontend",
      payload: { sampleRateHz, voiceMode: env.VOICE_MODE }
    }).catch(() => undefined);
    logger.info({ meetingId, sessionId, sampleRateHz, voiceMode: env.VOICE_MODE }, "orchestrated start");
    res.status(202).json({ accepted: true, meetingId, sessionId, voiceMode: env.VOICE_MODE });
  });

  router.post("/orchestrated/mic/append", (req: Request, res: Response) => {
    const parsed = appendSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid mic append payload", parsed.error.flatten());
    }
    const { meetingId, pcm16, timestampMs } = parsed.data;
    const ts = timestampMs ?? Date.now();
    const buf = Buffer.from(pcm16, "base64");
    if (env.VOICE_MODE === "staged") {
      stagedVoiceTurnRuntime.appendMicPcm16(meetingId, buf, ts);
    }
    void deps.runtimeEvents?.append({
      type: "realtime.mic.append",
      meetingId,
      actor: "frontend",
      payload: { bytes: buf.length, timestampMs: ts, voiceMode: env.VOICE_MODE }
    }).catch(() => undefined);
    res.status(202).json({ accepted: true, meetingId, voiceMode: env.VOICE_MODE });
  });

  return router;
}
