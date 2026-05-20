import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../logging/logger";
import type { InterviewSyncService } from "./interviewSyncService";
import type { RuntimeEventStore } from "./runtimeEventStore";
import type { JobAiInterviewStatus, StoredInterview } from "../types/interview";

type ControlWsEvent =
  | {
      eventType: "activity_mode_changed";
      role: "candidate";
      value: "listening" | "speaking";
    }
  | {
      eventType: "activity_mode_changed";
      role: "ai_agent";
      value: "listening" | "speaking" | "thinking" | "paused";
    }
  | {
      eventType: "current_question_changed";
      value: number | null;
    }
  | {
      eventType: "subtitles_delta";
      text: string;
    }
  | {
      eventType: "voice_turn_started";
      turnId: string;
      source?: string;
    }
  | {
      eventType: "voice_transcript_final";
      turnId: string;
      text: string;
    }
  | {
      eventType: "voice_agent_text";
      turnId: string;
      text: string;
    };

export type MeetingControlActivityRole = "candidate" | "ai_agent";
export type MeetingControlActivityValue =
  | "listening"
  | "speaking"
  | "thinking"
  | "paused";

const TERMINAL_JOBAI_STATUSES = new Set<JobAiInterviewStatus>([
  "completed",
  "stopped_during_meeting",
  "canceled",
  "meeting_not_started"
]);

export class MeetingControlWsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<number, Set<WebSocket>>();
  private pauseChangeHandler?: (input: { numericMeetingId: number; internalMeetingId: string; pauseEnabled: boolean }) => void;

  constructor(
    private readonly interviews: InterviewSyncService,
    private readonly runtimeEvents?: RuntimeEventStore
  ) {}

  setPauseChangeHandler(
    handler: (input: { numericMeetingId: number; internalMeetingId: string; pauseEnabled: boolean }) => void
  ): void {
    this.pauseChangeHandler = handler;
  }

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const parsed = this.parseMeetingId(req);
      if (!parsed.matches) {
        return;
      }
      if (typeof parsed.meetingId !== "number") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const stored = this.interviews.getInterviewByNumericMeetingId(parsed.meetingId);
      if (!stored) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.isAuthorized(req, stored) || this.isTerminal(stored)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, parsed.meetingId);
      });
    });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage, meetingId: number) => {
      this.addSocket(meetingId, ws);
      const internalMeetingId = internalMeetingIdFor(meetingId);
      void this.runtimeEvents?.append({
        type: "meeting.control.ws.connected",
        meetingId: internalMeetingId,
        actor: "frontend",
        payload: { numericMeetingId: meetingId }
      }).catch(() => undefined);
      logger.info({ meetingId, remoteAddress: req.socket.remoteAddress }, "meeting control websocket connected");

      ws.on("message", (data) => {
        this.handleMessage(meetingId, ws, data.toString());
      });
      ws.on("close", () => {
        this.removeSocket(meetingId, ws);
      });
    });
  }

  broadcast(meetingId: number, event: ControlWsEvent): void {
    const payload = JSON.stringify(event);
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  publishActivityMode(meetingId: number, role: "candidate", value: "listening" | "speaking"): void;
  publishActivityMode(meetingId: number, role: "ai_agent", value: "listening" | "speaking" | "thinking" | "paused"): void;
  publishActivityMode(meetingId: number, role: MeetingControlActivityRole, value: MeetingControlActivityValue): void {
    if (role === "candidate" && value !== "listening" && value !== "speaking") {
      return;
    }
    this.broadcast(meetingId, { eventType: "activity_mode_changed", role, value } as ControlWsEvent);
    void this.runtimeEvents?.append({
      type: "meeting.control.activity_mode_changed",
      meetingId: internalMeetingIdFor(meetingId),
      actor: "gateway",
      payload: { numericMeetingId: meetingId, role, value }
    }).catch(() => undefined);
  }

  publishCurrentQuestion(meetingId: number, value: number | null): void {
    this.broadcast(meetingId, { eventType: "current_question_changed", value });
    void this.runtimeEvents?.append({
      type: "meeting.control.current_question_changed",
      meetingId: internalMeetingIdFor(meetingId),
      actor: "gateway",
      payload: { numericMeetingId: meetingId, value }
    }).catch(() => undefined);
  }

  publishVoiceTurnStarted(meetingId: number, turnId: string, source?: string): void {
    this.broadcast(meetingId, { eventType: "voice_turn_started", turnId, source });
  }

  publishVoiceTranscriptFinal(meetingId: number, turnId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.broadcast(meetingId, { eventType: "voice_transcript_final", turnId, text: trimmed });
  }

  publishVoiceAgentText(meetingId: number, turnId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.broadcast(meetingId, { eventType: "voice_agent_text", turnId, text: trimmed });
  }

  publishSubtitlesDelta(meetingId: number, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.broadcast(meetingId, { eventType: "subtitles_delta", text: trimmed });
    void this.runtimeEvents?.append({
      type: "meeting.control.subtitles_delta",
      meetingId: internalMeetingIdFor(meetingId),
      actor: "gateway",
      payload: { numericMeetingId: meetingId, chars: trimmed.length }
    }).catch(() => undefined);
  }

  getConnectionCount(meetingId?: number): number {
    if (typeof meetingId === "number") {
      return this.sockets.get(meetingId)?.size ?? 0;
    }
    let total = 0;
    for (const sockets of this.sockets.values()) {
      total += sockets.size;
    }
    return total;
  }

  closeMeeting(meetingId: number, reason: string): void {
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      socket.close(1000, reason);
    }
    this.sockets.delete(meetingId);
  }

  private handleMessage(meetingId: number, ws: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "invalid_json" }));
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "invalid_payload" }));
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (event.eventType !== "set_pause_enabled" || typeof event.pauseEnabled !== "boolean") {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "unsupported_event" }));
      return;
    }

    const internalMeetingId = internalMeetingIdFor(meetingId);
    const pauseEnabled = event.pauseEnabled;
    void this.runtimeEvents?.append({
      type: "meeting.control.pause_changed",
      meetingId: internalMeetingId,
      actor: "frontend",
      payload: { numericMeetingId: meetingId, pauseEnabled }
    }).catch(() => undefined);
    void this.runtimeEvents?.recordCommand({
      commandId: randomUUID(),
      type: pauseEnabled ? "agent.pause" : "agent.resume",
      meetingId: internalMeetingId,
      issuedBy: "meeting_control_ws",
      createdAtMs: Date.now(),
      ackStatus: "accepted",
      revision: Date.now(),
      payload: { numericMeetingId: meetingId, pauseEnabled }
    }).catch(() => undefined);

    this.pauseChangeHandler?.({ numericMeetingId: meetingId, internalMeetingId, pauseEnabled });
    this.publishActivityMode(meetingId, "ai_agent", pauseEnabled ? "paused" : "listening");
  }

  private addSocket(meetingId: number, ws: WebSocket): void {
    const sockets = this.sockets.get(meetingId) ?? new Set<WebSocket>();
    sockets.add(ws);
    this.sockets.set(meetingId, sockets);
  }

  private removeSocket(meetingId: number, ws: WebSocket): void {
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.sockets.delete(meetingId);
    }
    void this.runtimeEvents?.append({
      type: "meeting.control.ws.disconnected",
      meetingId: internalMeetingIdFor(meetingId),
      actor: "frontend",
      payload: { numericMeetingId: meetingId, connectionCount: this.getConnectionCount(meetingId) }
    }).catch(() => undefined);
  }

  private parseMeetingId(req: IncomingMessage): { matches: boolean; meetingId?: number } {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/ws\/meeting\/(\d+)$/.exec(url.pathname);
    if (!match) {
      return { matches: false };
    }
    const meetingId = Number(match[1]);
    return Number.isSafeInteger(meetingId) && meetingId > 0 ? { matches: true, meetingId } : { matches: true };
  }

  private isAuthorized(req: IncomingMessage, stored: StoredInterview): boolean {
    const fromHeader = this.readBearerFromHeader(req);
    if (fromHeader && fromHeader === stored.projection.meetingControlKey) {
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get("token") ?? url.searchParams.get("meetingControlKey");
    return typeof q === "string" && q.trim() === stored.projection.meetingControlKey;
  }

  private readBearerFromHeader(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth !== "string") {
      return undefined;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim()) ?? /^Bearer:\s*(.+)$/i.exec(auth.trim());
    return bearer?.[1]?.trim();
  }

  private isTerminal(stored: StoredInterview): boolean {
    return (
      TERMINAL_JOBAI_STATUSES.has(stored.rawPayload.status) ||
      stored.projection.nullxesStatus === "completed" ||
      stored.projection.nullxesStatus === "stopped_during_meeting"
    );
  }
}

function internalMeetingIdFor(meetingId: number): string {
  return `nullxes-meeting-${meetingId}`;
}
