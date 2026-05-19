import express, { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { HttpError } from "../middleware/errorHandler";
import { OpenAIRealtimeClient } from "../services/openaiRealtimeClient";
import type { AvatarRuntimeSessionManager } from "../services/avatarRuntimeSessionManager";
import { inspectAudioDelta, rtmpTtsAudioTap } from "../services/rtmpTtsAudioTap";
import type { RuntimeEventStore } from "../services/runtimeEventStore";
import { InMemorySessionStore } from "../services/sessionStore";
import type { DataChannelEventPayload } from "../types/realtime";

const sdpBodyParser = express.raw({
  type: "application/sdp",
  limit: env.SDP_MAX_BYTES
});

interface RealtimeRouterDeps {
  openAIClient: OpenAIRealtimeClient;
  sessionStore: InMemorySessionStore;
  runtimeEvents?: RuntimeEventStore;
  avatarRuntime?: AvatarRuntimeSessionManager;
}

const keyAliases: Record<string, string> = {
  sessionID: "sessionId",
  session_id: "sessionId",
  event_id: "eventId",
  eventID: "eventId",
  tsms: "timestampMs",
  timestamp_ms: "timestampMs",
  event_type: "eventType",
  schema_version: "schemaVersion"
};

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function validateSdpPayload(req: Request): string {
  const contentType = req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/sdp")) {
    throw new HttpError(415, "Content-Type must be application/sdp");
  }

  if (!Buffer.isBuffer(req.body)) {
    throw new HttpError(400, "Invalid SDP body");
  }

  if (req.body.length === 0 || req.body.length > env.SDP_MAX_BYTES) {
    throw new HttpError(400, "SDP body is empty or exceeds size limit");
  }

  const sdpText = req.body.toString("utf8");
  const sdp = sdpText.replace(/\r?\n/g, "\r\n");
  if (!sdp.trimStart().startsWith("v=0")) {
    throw new HttpError(400, "Invalid SDP offer format");
  }

  return sdp;
}

function toCamelCase(input: string): string {
  return input.replace(/[_-]([a-z])/gi, (_match, letter: string) => letter.toUpperCase());
}

function normalizeEventValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeEventValue);
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = keyAliases[rawKey] ?? toCamelCase(rawKey);
      result[normalizedKey] = normalizeEventValue(rawValue);
    }
    return result;
  }

  return value;
}

function resolveEventType(event: Record<string, unknown>): string | undefined {
  const topLevelType =
    typeof event.type === "string"
      ? event.type
      : typeof event.eventType === "string"
        ? event.eventType
        : undefined;

  if (topLevelType) return topLevelType;

  const nestedPayload = event.payload;
  if (nestedPayload && typeof nestedPayload === "object") {
    const payload = nestedPayload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return payload.type;
    }
    if (typeof payload.eventType === "string") {
      return payload.eventType;
    }
  }

  return undefined;
}

function validateDataChannelEvent(body: unknown, routeSessionId: string): DataChannelEventPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Event payload must be an object");
  }

  const rawPayload = body as Record<string, unknown>;
  const normalizedPayload = normalizeEventValue(rawPayload) as Record<string, unknown>;

  if (typeof normalizedPayload.sessionId !== "string") {
    normalizedPayload.sessionId = routeSessionId;
  }

  const resolvedType = resolveEventType(normalizedPayload);
  if (!resolvedType || resolvedType.length === 0) {
    throw new HttpError(
      400,
      "Event payload requires a non-empty event type (type, eventType, event_type, or payload.type)"
    );
  }

  const timestampMs =
    typeof normalizedPayload.timestampMs === "number" ? normalizedPayload.timestampMs : Date.now();

  if (typeof normalizedPayload.schemaVersion !== "string") {
    normalizedPayload.schemaVersion = "1.0";
  }

  if (typeof normalizedPayload.source !== "string") {
    normalizedPayload.source = "client";
  }

  return {
    ...normalizedPayload,
    type: resolvedType,
    timestampMs,
    rawPayload,
    normalizedPayload
  };
}

export function createRealtimeRouter(deps: RealtimeRouterDeps): express.Router {
  const router = express.Router();

  router.get("/token", asyncHandler(async (req: Request, res: Response) => {
    const sessionConfig = deps.openAIClient.getDefaultSessionConfig();
    const token = await deps.openAIClient.createEphemeralClientSecret();
    const sessionId = uuidv4();
    deps.sessionStore.createSession(sessionId);
    deps.sessionStore.updateStatus(sessionId, "active");

    logger.info(
      {
        requestId: req.requestId,
        sessionId,
        tokenExpiresAt: token.expiresAt
      },
      "ephemeral token issued"
    );

    res.status(200).json({
      sessionId,
      token: token.value,
      expiresAt: token.expiresAt,
      session: sessionConfig
    });
  }));

  router.post("/session", sdpBodyParser, asyncHandler(async (req: Request, res: Response) => {
    const offerSdp = validateSdpPayload(req);
    const sessionId = uuidv4();

    deps.sessionStore.createSession(sessionId);

    try {
      const callResult = await deps.openAIClient.createRealtimeCall({
        sdp: offerSdp,
        session: deps.openAIClient.getDefaultSessionConfig()
      });

      deps.sessionStore.patchSession(sessionId, {
        status: "active",
        remoteCallId: callResult.remoteCallId
      });

      logger.info(
        {
          requestId: req.requestId,
          sessionId,
          remoteCallId: callResult.remoteCallId
        },
        "realtime session established"
      );

      res
        .status(200)
        .setHeader("content-type", "application/sdp")
        .setHeader("x-session-id", sessionId)
        .send(callResult.answerSdp);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown session error";
      deps.sessionStore.markError(sessionId, message);
      throw error;
    }
  }));

  router.post("/session/:sessionId/events", asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }

    const event = validateDataChannelEvent(req.body, sessionId);
    deps.sessionStore.registerEvent(sessionId, event);
    const normalized =
      event.normalizedPayload && typeof event.normalizedPayload === "object"
        ? (event.normalizedPayload as Record<string, unknown>)
        : {};
    const meetingId =
      typeof event.meetingId === "string"
        ? event.meetingId
        : typeof event.meetingId === "number"
          ? String(event.meetingId)
        : typeof normalized.meetingId === "string"
          ? normalized.meetingId
          : typeof normalized.meetingId === "number"
            ? String(normalized.meetingId)
          : undefined;
    const realtimeEvent = {
      meetingId,
      sessionId,
      type: event.type,
      rawPayload: event.rawPayload as Record<string, unknown>,
      normalizedPayload: event.normalizedPayload as Record<string, unknown>,
      timestampMs: typeof event.timestampMs === "number" ? event.timestampMs : undefined
    };
    deps.avatarRuntime?.handleRealtimeEvent(realtimeEvent);
    rtmpTtsAudioTap.handleRealtimeEvent(realtimeEvent);
    void deps.runtimeEvents?.append({
      type: "realtime.session.event",
      meetingId,
      sessionId,
      actor: typeof event.source === "string" ? event.source : "client",
      payload: {
        eventType: event.type,
        rawPayload: event.rawPayload,
        normalizedPayload: event.normalizedPayload
      }
    }).catch(() => undefined);

    logger.info(
      {
        requestId: req.requestId,
        sessionId,
        eventType: event.type,
        rawPayload: event.rawPayload,
        normalizedPayload: event.normalizedPayload
      },
      "datachannel event received"
    );

    // High-signal structured logs for production debugging.
    if (event.type === "session.update") {
      logger.info(
        { event: "openai_session_update_sent", requestId: req.requestId, sessionId, meetingId },
        "openai_session_update_sent"
      );
    }

    if (event.type === "response.create") {
      const raw = event.rawPayload as Record<string, unknown> | undefined;
      const responseObj =
        raw && typeof raw.response === "object" && raw.response !== null
          ? (raw.response as Record<string, unknown>)
          : undefined;
      if (responseObj && "modalities" in responseObj) {
        logger.warn(
          { event: "openai_legacy_response_modalities", requestId: req.requestId, sessionId, meetingId },
          "client sent deprecated response.modalities; OpenAI may reject"
        );
      }
      logger.info(
        { event: "openai_response_create_sent", requestId: req.requestId, sessionId, meetingId },
        "openai_response_create_sent"
      );
    }

    if (
      event.type === "response.audio.delta" ||
      event.type === "response.output_audio.delta" ||
      event.type === "output_audio.delta"
    ) {
      const deltaMeta = inspectAudioDelta({
        meetingId,
        sessionId,
        type: event.type,
        rawPayload: event.rawPayload as Record<string, unknown>,
        normalizedPayload: event.normalizedPayload as Record<string, unknown>
      });
      logger.info(
        {
          event: "openai_response_audio_delta_received",
          requestId: req.requestId,
          sessionId,
          meetingId,
          type: event.type,
          deltaExists: deltaMeta.deltaExists,
          deltaB64Length: deltaMeta.deltaB64Length,
          approxPcmBytes: deltaMeta.approxPcmBytes
        },
        "openai_response_audio_delta_received"
      );
    }

    if (event.type === "response.done") {
      logger.info(
        { event: "openai_response_done", requestId: req.requestId, sessionId, meetingId },
        "openai_response_done"
      );
    }

    if (event.type === "error" || event.type === "openai.error" || String(event.type).endsWith(".error")) {
      const payload = (event.rawPayload ?? event.normalizedPayload ?? {}) as Record<string, unknown>;
      const errorObj =
        payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : payload;
      const code = errorObj.code ?? errorObj.type;
      const param = errorObj.param;
      const message =
        typeof errorObj.message === "string"
          ? errorObj.message
          : typeof errorObj.text === "string"
            ? errorObj.text
            : undefined;
      logger.error(
        {
          msg: "openai_error",
          event: "openai_error",
          requestId: req.requestId,
          sessionId,
          meetingId,
          code,
          param,
          message,
          eventType: typeof payload.type === "string" ? payload.type : event.type
        },
        "openai_error"
      );
    }

    res.status(202).json({
      status: "accepted",
      sessionId,
      eventType: event.type
    });
  }));

  router.get("/session/:sessionId", (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }
    res.status(200).json({ session });
  });

  router.delete("/session/:sessionId", (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }

    deps.sessionStore.patchSession(sessionId, {
      status: "closed",
      closedAt: Date.now()
    });

    logger.info({ requestId: req.requestId, sessionId }, "session closed by client");
    res.status(204).send();
  });

  return router;
}
