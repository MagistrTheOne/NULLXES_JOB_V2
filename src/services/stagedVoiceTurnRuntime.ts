import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { buildOpeningUtteranceForAgentSpeak } from "./dialoguePromptBuilder";
import { dialogueStateStore, type DialogueInterviewContext } from "./dialogueStateStore";
import { generateDialogueReply } from "./openaiResponsesDialogue";
import { OPENAI_TTS_PCM_SAMPLE_RATE_HZ, streamOpenAiSpeechPcm } from "./openaiSpeechPcmStream";
import { transcribePcm16Turn } from "./openaiTranscriptionTurn";
import type { MeetingControlWsHub } from "./meetingControlWsHub";
import { rtmpTtsSessionManager } from "./rtmpTtsSessionManager";
import type { RuntimeEventStore } from "./runtimeEventStore";

export type StagedVoiceTtsListener = (input: {
  meetingId: string;
  pcm16: Buffer;
  sampleRateHz: number;
  timestampMs: number;
}) => void;

type VoiceSessionState = "starting" | "active" | "processing_turn" | "closed";

type VoiceSession = {
  meetingId: string;
  sessionId: string;
  numericMeetingId: number;
  sampleRateHz: number;
  state: VoiceSessionState;
  pcmBuffer: Buffer;
  speechStartedAtMs: number;
  lastSpeechAtMs: number;
  speechAccumMs: number;
  turnGeneration: number;
  inFlightAbort?: AbortController;
  controlWsHub?: MeetingControlWsHub;
  runtimeEvents?: RuntimeEventStore;
};

function pcm16Rms(pcm: Buffer): number {
  const samples = pcm.length / 2;
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class StagedVoiceTurnRuntime {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly ttsListeners = new Set<StagedVoiceTtsListener>();

  isStagedMode(): boolean {
    return env.VOICE_MODE === "staged";
  }

  onTtsPcm16(listener: StagedVoiceTtsListener): () => void {
    this.ttsListeners.add(listener);
    return () => this.ttsListeners.delete(listener);
  }

  start(input: {
    meetingId: string;
    sessionId: string;
    numericMeetingId: number;
    sampleRateHz?: number;
    dialogueContext?: DialogueInterviewContext;
    controlWsHub?: MeetingControlWsHub;
    runtimeEvents?: RuntimeEventStore;
  }): void {
    const sampleRateHz = input.sampleRateHz ?? 16_000;
    dialogueStateStore.upsert({
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      dialogueContext: input.dialogueContext
    });

    this.sessions.set(input.meetingId, {
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      numericMeetingId: input.numericMeetingId,
      sampleRateHz,
      state: "active",
      pcmBuffer: Buffer.alloc(0),
      speechStartedAtMs: 0,
      lastSpeechAtMs: 0,
      speechAccumMs: 0,
      turnGeneration: 0,
      controlWsHub: input.controlWsHub,
      runtimeEvents: input.runtimeEvents
    });

    void input.runtimeEvents
      ?.append({
        type: "voice.pipeline.mode",
        meetingId: input.meetingId,
        sessionId: input.sessionId,
        actor: "gateway",
        payload: { voiceMode: "staged", sampleRateHz, numericMeetingId: input.numericMeetingId }
      })
      .catch(() => undefined);

    logger.info(
      { meetingId: input.meetingId, sessionId: input.sessionId, numericMeetingId: input.numericMeetingId, sampleRateHz },
      "staged voice session started"
    );
  }

  appendMicPcm16(meetingId: string, pcm16: Buffer, timestampMs: number): void {
    const session = this.sessions.get(meetingId);
    if (!session || session.state === "closed" || pcm16.length === 0) {
      return;
    }
    if (session.state === "starting") {
      session.state = "active";
    }

    const rms = pcm16Rms(pcm16);
    const chunkMs = (pcm16.length / 2 / session.sampleRateHz) * 1000;
    const isSpeech = rms >= env.VOICE_VAD_RMS_THRESHOLD;

    if (isSpeech) {
      if (session.speechStartedAtMs === 0) {
        session.speechStartedAtMs = timestampMs;
        if (session.state === "processing_turn") {
          this.interrupt(meetingId, "barge_in");
        }
        session.controlWsHub?.publishActivityMode(session.numericMeetingId, "candidate", "speaking");
      }
      session.lastSpeechAtMs = timestampMs;
      session.speechAccumMs += chunkMs;
    } else if (session.speechStartedAtMs > 0) {
      const silenceMs = timestampMs - session.lastSpeechAtMs;
      if (
        silenceMs >= env.TURN_VAD_SILENCE_MS &&
        session.speechAccumMs >= env.TURN_VAD_MIN_SPEECH_MS
      ) {
        session.controlWsHub?.publishActivityMode(session.numericMeetingId, "candidate", "listening");
        void this.commitTurn(meetingId, "vad");
        return;
      }
    }

    if (session.pcmBuffer.length + pcm16.length > env.VOICE_PCM_BUFFER_MAX_BYTES) {
      const drop = session.pcmBuffer.length + pcm16.length - env.VOICE_PCM_BUFFER_MAX_BYTES;
      session.pcmBuffer = session.pcmBuffer.subarray(Math.min(drop, session.pcmBuffer.length));
      logger.warn({ meetingId, dropBytes: drop }, "staged voice pcm buffer trimmed");
    }
    session.pcmBuffer = session.pcmBuffer.length
      ? Buffer.concat([session.pcmBuffer, pcm16])
      : Buffer.from(pcm16);
  }

  async commitTurn(meetingId: string, source: string): Promise<{ turnId: string; skipped?: boolean }> {
    const session = this.sessions.get(meetingId);
    if (!session || session.state === "closed") {
      return { turnId: "", skipped: true };
    }

    const pcm = session.pcmBuffer;
    session.pcmBuffer = Buffer.alloc(0);
    session.speechStartedAtMs = 0;
    session.lastSpeechAtMs = 0;
    session.speechAccumMs = 0;

    if (pcm.length < session.sampleRateHz * 2 * 0.2) {
      return { turnId: "", skipped: true };
    }

    const turnId = randomUUID();
    const generation = ++session.turnGeneration;
    session.state = "processing_turn";

    session.inFlightAbort?.abort();
    const abort = new AbortController();
    session.inFlightAbort = abort;

    session.controlWsHub?.publishVoiceTurnStarted(session.numericMeetingId, turnId, source);

    void session.runtimeEvents
      ?.append({
        type: "voice.turn.started",
        meetingId,
        sessionId: session.sessionId,
        actor: "gateway",
        payload: { turnId, source, pcmBytes: pcm.length }
      })
      .catch(() => undefined);

    void this.runTurnPipeline(session, turnId, generation, pcm, abort.signal).catch((err: unknown) => {
      logger.warn(
        {
          meetingId,
          turnId,
          error: err instanceof Error ? err.message : String(err)
        },
        "staged voice turn pipeline failed"
      );
    });

    return { turnId };
  }

  async agentSpeak(meetingId: string, text?: string): Promise<{ turnId: string; replyText: string }> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new Error("staged_voice_session_missing");
    }
    const state = dialogueStateStore.get(meetingId);
    const replyText = text?.trim() || buildOpeningUtteranceForAgentSpeak(state?.dialogueContext);
    const turnId = randomUUID();
    const generation = ++session.turnGeneration;
    session.inFlightAbort?.abort();
    const abort = new AbortController();
    session.inFlightAbort = abort;

    session.controlWsHub?.publishVoiceAgentText(session.numericMeetingId, turnId, replyText);
    await this.streamTtsToOutputs(session, turnId, generation, replyText, abort.signal);
    session.state = "active";
    return { turnId, replyText };
  }

  interrupt(meetingId: string, reason: string): void {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    session.inFlightAbort?.abort();
    session.inFlightAbort = undefined;
    session.turnGeneration += 1;
    session.pcmBuffer = Buffer.alloc(0);
    session.speechStartedAtMs = 0;
    session.speechAccumMs = 0;
    session.state = "active";
    session.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "listening");
    logger.info({ meetingId, reason }, "staged voice interrupt");
  }

  close(meetingId: string): void {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    session.inFlightAbort?.abort();
    session.state = "closed";
    this.sessions.delete(meetingId);
    dialogueStateStore.delete(meetingId);
    logger.info({ meetingId }, "staged voice session closed");
  }

  private async runTurnPipeline(
    session: VoiceSession,
    turnId: string,
    generation: number,
    pcm: Buffer,
    signal: AbortSignal
  ): Promise<void> {
    const { meetingId, sessionId } = session;
    const dialogue = dialogueStateStore.get(meetingId);

    try {
      const stt = await transcribePcm16Turn({
        pcm16: pcm,
        sampleRateHz: session.sampleRateHz,
        prompt: dialogue?.dialogueContext
          ? `${dialogue.dialogueContext.candidateFirstName ?? ""} ${dialogue.dialogueContext.candidateLastName ?? ""}`.trim()
          : undefined,
        signal
      });

      if (generation !== session.turnGeneration) {
        return;
      }

      void session.runtimeEvents
        ?.append({
          type: "voice.turn.stt",
          meetingId,
          sessionId,
          actor: "openai",
          payload: { turnId, sttMs: stt.durationMs, sttChars: stt.text.length }
        })
        .catch(() => undefined);

      if (stt.text) {
        session.controlWsHub?.publishSubtitlesDelta(session.numericMeetingId, stt.text);
        session.controlWsHub?.publishVoiceTranscriptFinal(session.numericMeetingId, turnId, stt.text);
      }

      const candidateText = stt.text.trim();
      if (!candidateText) {
        session.state = "active";
        return;
      }

      session.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "thinking");

      const llm = await generateDialogueReply({
        candidateText,
        dialogueContext: dialogue?.dialogueContext,
        previousResponseId: dialogue?.lastResponseId,
        signal
      });

      if (generation !== session.turnGeneration) {
        return;
      }

      if (llm.responseId) {
        dialogueStateStore.patch(meetingId, { lastResponseId: llm.responseId });
      }

      void session.runtimeEvents
        ?.append({
          type: "voice.turn.llm",
          meetingId,
          sessionId,
          actor: "openai",
          payload: { turnId, llmMs: llm.durationMs, replyChars: llm.replyText.length, responseId: llm.responseId }
        })
        .catch(() => undefined);

      session.controlWsHub?.publishVoiceAgentText(session.numericMeetingId, turnId, llm.replyText);
      session.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "speaking");

      await this.streamTtsToOutputs(session, turnId, generation, llm.replyText, signal);

      if (generation === session.turnGeneration) {
        session.state = "active";
        session.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "listening");
      }
    } catch (err: unknown) {
      if (generation === session.turnGeneration) {
        session.state = "active";
      }
      void session.runtimeEvents
        ?.append({
          type: "voice.turn.failed",
          meetingId,
          sessionId,
          actor: "gateway",
          payload: {
            turnId,
            error: err instanceof Error ? err.message : String(err)
          }
        })
        .catch(() => undefined);
      throw err;
    }
  }

  private async streamTtsToOutputs(
    session: VoiceSession,
    turnId: string,
    generation: number,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    const ttsStartedAt = Date.now();
    let firstByteMs: number | null = null;

    const result = await streamOpenAiSpeechPcm({
      text,
      signal,
      onChunk: async (pcm16) => {
        if (generation !== session.turnGeneration) {
          return;
        }
        const timestampMs = Date.now();
        if (env.RTMP_INGRESS_ENABLED && rtmpTtsSessionManager.isActive(session.numericMeetingId)) {
          rtmpTtsSessionManager.writePcm16(session.numericMeetingId, pcm16);
        }
        for (const listener of this.ttsListeners) {
          try {
            listener({
              meetingId: session.meetingId,
              pcm16,
              sampleRateHz: OPENAI_TTS_PCM_SAMPLE_RATE_HZ,
              timestampMs
            });
          } catch {
            /* noop */
          }
        }
      }
    });

    firstByteMs = result.firstByteMs;

    void session.runtimeEvents
      ?.append({
        type: "voice.turn.tts",
        meetingId: session.meetingId,
        sessionId: session.sessionId,
        actor: "openai",
        payload: {
          turnId,
          ttsMs: result.durationMs,
          ttsFirstByteMs: firstByteMs,
          pcmBytes: result.totalBytes
        }
      })
      .catch(() => undefined);
  }

}

export const stagedVoiceTurnRuntime = new StagedVoiceTurnRuntime();
