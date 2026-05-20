import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { MeetingControlWsHub } from "./meetingControlWsHub";
import { OpenAiRealtimeWsSttClient } from "./openaiRealtimeWsSttClient";
import { rtmpReceiverSessionManager } from "./rtmpReceiverSessionManager";
import { stagedVoiceTurnRuntime } from "./stagedVoiceTurnRuntime";
import type { RuntimeEventStore } from "./runtimeEventStore";
import type { DialogueInterviewContext } from "./dialogueStateStore";

const PCM_CHUNK_TARGET_BYTES = 4800; // ~100 ms @ 24 kHz mono s16le
const RTMP_PCM_SAMPLE_RATE_HZ = 24_000;

type BridgeSession = {
  numericMeetingId: number;
  internalMeetingId: string;
  mode: "realtime_ws" | "staged";
  sttClient?: OpenAiRealtimeWsSttClient;
  pcmUnsub: () => void;
  pcmBuffer: Buffer;
  paused: boolean;
  sessionId: string;
};

class RtmpSttBridge {
  private readonly sessions = new Map<number, BridgeSession>();

  isEnabled(): boolean {
    return env.RTMP_RECEIVER_ENABLED;
  }

  isActive(numericMeetingId: number): boolean {
    return this.sessions.has(numericMeetingId);
  }

  async start(input: {
    numericMeetingId: number;
    internalMeetingId: string;
    controlWsHub?: MeetingControlWsHub;
    runtimeEvents?: RuntimeEventStore;
    dialogueContext?: DialogueInterviewContext;
  }): Promise<{ agentReceiverRTMPURL: string }> {
    if (!this.isEnabled()) {
      throw new Error("rtmp_stt_disabled");
    }

    await this.stop(input.numericMeetingId);

    const receiver = await rtmpReceiverSessionManager.start({ meetingId: input.numericMeetingId });
    const sessionId = `${input.internalMeetingId}-rtmp`;
    const useStaged = env.VOICE_MODE === "staged";

    if (useStaged) {
      stagedVoiceTurnRuntime.start({
        meetingId: input.internalMeetingId,
        sessionId,
        numericMeetingId: input.numericMeetingId,
        sampleRateHz: RTMP_PCM_SAMPLE_RATE_HZ,
        dialogueContext: input.dialogueContext,
        controlWsHub: input.controlWsHub,
        runtimeEvents: input.runtimeEvents
      });
    }

    let sttClient: OpenAiRealtimeWsSttClient | undefined;
    if (!useStaged) {
      sttClient = new OpenAiRealtimeWsSttClient(input.numericMeetingId, {
        onTranscriptDelta: (delta) => {
          input.controlWsHub?.publishSubtitlesDelta(input.numericMeetingId, delta);
          void input.runtimeEvents
            ?.append({
              type: "rtmp.stt.transcript_delta",
              meetingId: input.internalMeetingId,
              actor: "openai",
              payload: { numericMeetingId: input.numericMeetingId, chars: delta.length }
            })
            .catch(() => undefined);
          logger.debug({ meetingId: input.numericMeetingId, delta: delta.slice(0, 80) }, "rtmp stt transcript delta");
        },
        onSpeechStarted: () => {
          input.controlWsHub?.publishActivityMode(input.numericMeetingId, "candidate", "speaking");
        },
        onSpeechStopped: () => {
          input.controlWsHub?.publishActivityMode(input.numericMeetingId, "candidate", "listening");
        },
        onError: (message) => {
          logger.warn({ meetingId: input.numericMeetingId, message }, "rtmp stt openai ws error");
        }
      });
    }

    const session: BridgeSession = {
      numericMeetingId: input.numericMeetingId,
      internalMeetingId: input.internalMeetingId,
      mode: useStaged ? "staged" : "realtime_ws",
      sttClient,
      sessionId,
      pcmUnsub: rtmpReceiverSessionManager.onPcm(input.numericMeetingId, (chunk) => {
        this.ingestPcm(input.numericMeetingId, chunk);
      }),
      pcmBuffer: Buffer.alloc(0),
      paused: false
    };
    this.sessions.set(input.numericMeetingId, session);

    if (sttClient) {
      try {
        await sttClient.connect();
      } catch (err: unknown) {
        await this.stop(input.numericMeetingId);
        throw err;
      }
    }

    void input.runtimeEvents
      ?.append({
        type: useStaged ? "voice.rtmp.receiver.started" : "rtmp.stt.started",
        meetingId: input.internalMeetingId,
        actor: "gateway",
        payload: {
          numericMeetingId: input.numericMeetingId,
          agentReceiverRTMPURL: receiver.agentReceiverRTMPURL,
          voiceMode: env.VOICE_MODE
        }
      })
      .catch(() => undefined);

    logger.info(
      {
        meetingId: input.numericMeetingId,
        agentReceiverRTMPURL: receiver.agentReceiverRTMPURL,
        voiceMode: env.VOICE_MODE,
        bridgeMode: session.mode
      },
      "rtmp receiver bridge started"
    );

    return { agentReceiverRTMPURL: receiver.agentReceiverRTMPURL };
  }

  ingestPcm(numericMeetingId: number, chunk: Buffer): void {
    const session = this.sessions.get(numericMeetingId);
    if (!session || session.paused || chunk.length === 0) {
      return;
    }

    if (session.mode === "staged") {
      stagedVoiceTurnRuntime.appendMicPcm16(session.internalMeetingId, chunk, Date.now());
      return;
    }

    session.pcmBuffer = session.pcmBuffer.length
      ? Buffer.concat([session.pcmBuffer, chunk])
      : Buffer.from(chunk);

    while (session.pcmBuffer.length >= PCM_CHUNK_TARGET_BYTES) {
      const slice = session.pcmBuffer.subarray(0, PCM_CHUNK_TARGET_BYTES);
      session.pcmBuffer = session.pcmBuffer.subarray(PCM_CHUNK_TARGET_BYTES);
      session.sttClient?.appendPcm16(slice);
    }
  }

  setPauseEnabled(numericMeetingId: number, pauseEnabled: boolean): void {
    const session = this.sessions.get(numericMeetingId);
    if (!session) {
      return;
    }
    session.paused = pauseEnabled;
    session.sttClient?.setPaused(pauseEnabled);
    if (!pauseEnabled && session.mode === "realtime_ws") {
      if (session.pcmBuffer.length > 0) {
        session.sttClient?.appendPcm16(session.pcmBuffer);
        session.pcmBuffer = Buffer.alloc(0);
      }
    }
  }

  async stop(numericMeetingId: number): Promise<void> {
    const session = this.sessions.get(numericMeetingId);
    if (!session) {
      await rtmpReceiverSessionManager.stop(numericMeetingId);
      return;
    }

    this.sessions.delete(numericMeetingId);
    session.pcmUnsub();
    session.sttClient?.close();
    if (session.mode === "staged") {
      stagedVoiceTurnRuntime.close(session.internalMeetingId);
    }
    await rtmpReceiverSessionManager.stop(numericMeetingId);
    logger.info({ meetingId: numericMeetingId, mode: session.mode }, "rtmp receiver bridge stopped");
  }
}

export const rtmpSttBridge = new RtmpSttBridge();
