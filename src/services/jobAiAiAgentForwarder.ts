import { env } from "../config/env";
import { logger } from "../logging/logger";

export type AiAgentStopReason = "candidate_leaved" | "candidate_stopped_ui";

export async function forwardAiAgentMeetingStart(input: {
  meetingId: number;
  meetingControlKey: string;
  agentRTMPURL: string;
}): Promise<{ agentReceiverRTMPURL: string }> {
  const base = env.JOBAI_AI_AGENT_API_BASE_URL?.replace(/\/+$/, "");
  if (!base) {
    throw new Error("ai_agent_base_not_configured");
  }
  const url = new URL("meetings/start", `${base}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.JOBAI_AI_AGENT_START_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.meetingControlKey}`
      },
      body: JSON.stringify({
        meetingId: input.meetingId,
        agentRTMPURL: input.agentRTMPURL
      }),
      signal: controller.signal
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const errCode = typeof json.errorCode === "string" ? json.errorCode : "";
      if (res.status === 400 && errCode === "rtmp_receiver_not_ready") {
        throw new RtmpReceiverNotReadyError(text.slice(0, 400));
      }
      throw new Error(`ai_agent_start_http_${res.status}: ${text.slice(0, 400)}`);
    }
    const receiver =
      typeof json.agentReceiverRTMPURL === "string"
        ? json.agentReceiverRTMPURL
        : typeof (json as { agent_receiver_rtmp_url?: string }).agent_receiver_rtmp_url === "string"
          ? (json as { agent_receiver_rtmp_url: string }).agent_receiver_rtmp_url
          : "";
    if (!receiver.trim()) {
      throw new RtmpReceiverNotReadyError("missing agentReceiverRTMPURL in AI agent response");
    }
    return { agentReceiverRTMPURL: receiver.trim() };
  } finally {
    clearTimeout(timer);
  }
}

export class RtmpReceiverNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RtmpReceiverNotReadyError";
  }
}

export async function forwardAiAgentMeetingStop(input: {
  meetingId: number;
  meetingControlKey: string;
  stopReason: AiAgentStopReason;
}): Promise<boolean> {
  const base = env.JOBAI_AI_AGENT_API_BASE_URL?.replace(/\/+$/, "");
  if (!base) {
    return false;
  }
  const url = new URL("meetings/stop", `${base}/`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.meetingControlKey}`
    },
    body: JSON.stringify({
      meetingId: input.meetingId,
      stopReason: input.stopReason
    }),
    signal: AbortSignal.timeout(25_000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ meetingId: input.meetingId, status: res.status, text: text.slice(0, 300) }, "ai agent meetings/stop failed");
    return false;
  }
  return true;
}

export async function forwardAiAgentMeetingStopWithRetries(input: {
  meetingId: number;
  meetingControlKey: string;
  stopReason: AiAgentStopReason;
}): Promise<void> {
  const base = env.JOBAI_AI_AGENT_API_BASE_URL?.trim();
  if (!base) {
    return;
  }
  for (let attempt = 1; attempt <= env.JOBAI_DEINIT_AI_MAX_ATTEMPTS; attempt += 1) {
    const ok = await forwardAiAgentMeetingStop(input).catch(() => false);
    if (ok) {
      return;
    }
    if (attempt < env.JOBAI_DEINIT_AI_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, env.JOBAI_DEINIT_AI_DELAY_MS));
    }
  }
  logger.error({ meetingId: input.meetingId }, "ai agent meetings/stop exhausted retries");
}
