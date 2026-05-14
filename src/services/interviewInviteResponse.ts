import { env } from "../config/env";
import type { InviteTokenRole, StoredInterview } from "../types/interview";

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function questionsCount(stored: StoredInterview): number | null {
  const questions = stored.rawPayload.specialty?.questions;
  return Array.isArray(questions) ? questions.length : null;
}

export function resolveAiWsUrlForMeeting(meetingId: number): string {
  const template = env.NULLXES_AI_WS_URL_TEMPLATE?.trim();
  if (template) {
    return template.replace(/\{meetingId\}/g, String(meetingId));
  }
  return env.NULLXES_AI_WS_URL;
}

/** JSON body aligned with ЧТЗ п.2.1 (same fields as POST /interviews/get-by-token success). */
export function buildInterviewGetByTokenPayload(interview: StoredInterview, role: InviteTokenRole): Record<string, unknown> {
  return {
    role,
    candidate: {
      firstName: interview.projection.candidateFirstName,
      lastName: interview.projection.candidateLastName,
      patronymic: null
    },
    meetingAt: interview.projection.meetingAt,
    aiWSURL: resolveAiWsUrlForMeeting(interview.projection.meetingId),
    companyName: nullableText(interview.rawPayload.companyName),
    questionsCount: questionsCount(interview),
    meetingId: interview.projection.meetingId,
    meetingControlKey: interview.projection.meetingControlKey
  };
}

export function liveKitRoomNameForNumericMeetingId(meetingId: number): string {
  return `nullxes-meeting-${meetingId}`;
}

export function deriveLiveKitHttpHost(): string | undefined {
  if (env.LIVEKIT_HTTP_HOST?.trim()) {
    return env.LIVEKIT_HTTP_HOST.replace(/\/+$/, "");
  }
  const u = env.LIVEKIT_URL?.trim();
  if (!u) return undefined;
  try {
    const parsed = new URL(u);
    const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Поля для ffmpeg / LiveKit **ingress** приходят с контуром JobAI (webhook → raw interview).
 * Gateway **не** вызывает LiveKit Room/Ingress API — только отдаёт их клиенту вместе с JWT-путём.
 * Имена ключей не меняем: это контракт партнёра.
 */
const LIVEKIT_INGRESS_PASSTHROUGH_KEYS = [
  "agentRTMPURL",
  "livekitIngressRtmpUrl",
  "livekitIngressStreamKey",
  "livekitRtmpUrl",
  "ingressUrl",
  "liveKitIngressUrl"
] as const;

export function pickLiveKitIngressHintsFromInterview(raw: StoredInterview["rawPayload"]): Record<string, string> {
  const r = raw as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of LIVEKIT_INGRESS_PASSTHROUGH_KEYS) {
    const v = r[k];
    if (typeof v === "string" && v.trim().length > 0) {
      out[k] = v.trim();
    }
  }
  return out;
}
