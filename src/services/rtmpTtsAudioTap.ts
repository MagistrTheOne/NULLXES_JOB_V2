import { rtmpTtsSessionManager } from "./rtmpTtsSessionManager";

type RealtimeEventInput = {
  meetingId?: string;
  type: string;
  rawPayload?: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;
};

type TapRegistration = {
  internalMeetingId: string;
  numericMeetingId: number;
};

class RtmpTtsAudioTap {
  private readonly byInternal = new Map<string, TapRegistration>();

  register(internalMeetingId: string, numericMeetingId: number): void {
    this.unregister(internalMeetingId);
    this.byInternal.set(internalMeetingId, { internalMeetingId, numericMeetingId });
  }

  unregister(internalMeetingId: string): void {
    this.byInternal.delete(internalMeetingId);
  }

  unregisterByNumeric(numericMeetingId: number): void {
    for (const [internalId, reg] of this.byInternal.entries()) {
      if (reg.numericMeetingId === numericMeetingId) {
        this.byInternal.delete(internalId);
      }
    }
  }

  handleRealtimeEvent(input: RealtimeEventInput): void {
    const meetingId = input.meetingId?.trim();
    if (!meetingId) {
      return;
    }
    const reg = this.byInternal.get(meetingId);
    if (!reg || !rtmpTtsSessionManager.isActive(reg.numericMeetingId)) {
      return;
    }

    const audioDelta = extractAudioDelta(input);
    if (!audioDelta) {
      return;
    }

    const pcm16 = Buffer.from(audioDelta, "base64");
    if (pcm16.length === 0) {
      return;
    }

    rtmpTtsSessionManager.writePcm16(reg.numericMeetingId, pcm16);
  }
}

function extractAudioDelta(input: RealtimeEventInput): string | null {
  if (
    input.type !== "response.audio.delta" &&
    input.type !== "response.output_audio.delta" &&
    input.type !== "output_audio.delta"
  ) {
    return null;
  }
  const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
  for (const payload of payloads) {
    const delta = payload.delta ?? payload.audio ?? payload.pcm16;
    if (typeof delta === "string" && delta.trim()) {
      return delta;
    }
  }
  return null;
}

export const rtmpTtsAudioTap = new RtmpTtsAudioTap();
