import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { dialogueStateStore, type DialogueInterviewContext } from "../services/dialogueStateStore";
import type { InterviewSyncService } from "../services/interviewSyncService";
import type { MeetingControlWsHub } from "../services/meetingControlWsHub";
import type { RuntimeEventStore } from "../services/runtimeEventStore";
import { stagedVoiceTurnRuntime } from "../services/stagedVoiceTurnRuntime";

export interface VoiceRouterDeps {
  runtimeEvents?: RuntimeEventStore;
  controlWsHub?: MeetingControlWsHub;
  interviews?: InterviewSyncService;
}

const startSchema = z.object({
  meetingId: z.string().min(1),
  sessionId: z.string().min(1),
  sampleRateHz: z.number().int().positive().default(16_000),
  numericMeetingId: z.number().int().positive().optional(),
  dialogueContext: z.record(z.unknown()).optional()
});

const appendSchema = z.object({
  meetingId: z.string().min(1),
  pcm16: z.string().min(1),
  timestampMs: z.number().int().nonnegative().optional()
});

const commitSchema = z.object({
  meetingId: z.string().min(1)
});

const agentSpeakSchema = z.object({
  meetingId: z.string().min(1),
  text: z.string().optional()
});

function parseNumericMeetingId(meetingId: string, explicit?: number): number {
  if (typeof explicit === "number") {
    return explicit;
  }
  const match = /^nullxes-meeting-(\d+)$/.exec(meetingId);
  if (match) {
    return Number(match[1]);
  }
  throw new HttpError(400, "numeric_meeting_id_required");
}

function dialogueContextFromInterview(
  interviews: InterviewSyncService | undefined,
  numericMeetingId: number
): DialogueInterviewContext | undefined {
  const stored = interviews?.getInterviewByNumericMeetingId(numericMeetingId);
  if (!stored) {
    return undefined;
  }
  const raw = stored.rawPayload;
  const questions =
    raw.specialty?.questions?.map((q) => ({ text: q.text, order: q.order })) ??
    [];
  return {
    candidateFirstName: raw.candidateFirstName,
    candidateLastName: raw.candidateLastName,
    companyName: raw.companyName,
    jobTitle: raw.jobTitle,
    vacancyText: raw.vacancyText,
    specialtyName: raw.specialty?.name,
    greetingSpeech: raw.greetingSpeech,
    finalSpeech: raw.finalSpeech,
    questions
  };
}

function assertStagedMode(): void {
  if (env.VOICE_MODE !== "staged") {
    throw new HttpError(409, "voice_mode_not_staged");
  }
}

export function createVoiceRouter(deps: VoiceRouterDeps): express.Router {
  const router = express.Router();

  router.get("/config", (_req: Request, res: Response) => {
    res.status(200).json({
      voiceMode: env.VOICE_MODE,
      sttModel: env.OPENAI_STT_TRANSCRIPTION_MODEL,
      llmModel: env.OPENAI_LLM_MODEL,
      ttsModel: env.OPENAI_TTS_MODEL
    });
  });

  router.post("/sessions/start", async (req: Request, res: Response) => {
    assertStagedMode();
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid voice start payload", parsed.error.flatten());
    }

    const numericMeetingId = parseNumericMeetingId(parsed.data.meetingId, parsed.data.numericMeetingId);
    const dialogueContext =
      (parsed.data.dialogueContext as DialogueInterviewContext | undefined) ??
      dialogueContextFromInterview(deps.interviews, numericMeetingId);

    stagedVoiceTurnRuntime.start({
      meetingId: parsed.data.meetingId,
      sessionId: parsed.data.sessionId,
      numericMeetingId,
      sampleRateHz: parsed.data.sampleRateHz,
      dialogueContext,
      controlWsHub: deps.controlWsHub,
      runtimeEvents: deps.runtimeEvents
    });

    dialogueStateStore.upsert({
      meetingId: parsed.data.meetingId,
      sessionId: parsed.data.sessionId,
      dialogueContext
    });

    logger.info(
      {
        meetingId: parsed.data.meetingId,
        sessionId: parsed.data.sessionId,
        numericMeetingId,
        sampleRateHz: parsed.data.sampleRateHz
      },
      "voice session start accepted"
    );

    res.status(202).json({
      accepted: true,
      voiceMode: "staged",
      meetingId: parsed.data.meetingId,
      sessionId: parsed.data.sessionId,
      numericMeetingId
    });
  });

  router.post("/mic/append", (req: Request, res: Response) => {
    assertStagedMode();
    const parsed = appendSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid mic append payload", parsed.error.flatten());
    }

    const pcm = Buffer.from(parsed.data.pcm16, "base64");
    const timestampMs = parsed.data.timestampMs ?? Date.now();
    stagedVoiceTurnRuntime.appendMicPcm16(parsed.data.meetingId, pcm, timestampMs);

    res.status(202).json({ accepted: true, bytes: pcm.length });
  });

  router.post("/turn/commit", async (req: Request, res: Response) => {
    assertStagedMode();
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid turn commit payload", parsed.error.flatten());
    }

    const result = await stagedVoiceTurnRuntime.commitTurn(parsed.data.meetingId, "manual");
    res.status(202).json({ accepted: true, ...result });
  });

  router.post("/agent/speak", async (req: Request, res: Response) => {
    assertStagedMode();
    const parsed = agentSpeakSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid agent speak payload", parsed.error.flatten());
    }

    const result = await stagedVoiceTurnRuntime.agentSpeak(parsed.data.meetingId, parsed.data.text);
    res.status(202).json({ accepted: true, ...result });
  });

  router.post("/sessions/close", (req: Request, res: Response) => {
    const meetingId = typeof req.body?.meetingId === "string" ? req.body.meetingId : "";
    if (!meetingId) {
      throw new HttpError(400, "meeting_id_required");
    }
    stagedVoiceTurnRuntime.close(meetingId);
    res.status(204).send();
  });

  return router;
}
