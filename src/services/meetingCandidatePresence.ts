import { env } from "../config/env";
import { logger } from "../logging/logger";

type Row = {
  lastPingAtMs: number;
  sessionStartedAtMs: number | null;
  stopped: boolean;
};

/**
 * ЧТЗ п.1.4 / п.4.1 — candidate presence and wall-clock session budget (single gateway instance).
 * Multi-instance: replace with Redis-backed store.
 */
export class MeetingCandidatePresenceTracker {
  private readonly rows = new Map<number, Row>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private onAutoDeinit?: (meetingId: number, reason: "candidate_absent" | "max_wall_time") => void;

  setAutoDeinitHandler(handler: (meetingId: number, reason: "candidate_absent" | "max_wall_time") => void): void {
    this.onAutoDeinit = handler;
  }

  markStopped(meetingId: number): void {
    const row = this.rows.get(meetingId);
    if (row) {
      row.stopped = true;
    } else {
      this.rows.set(meetingId, {
        lastPingAtMs: Date.now(),
        sessionStartedAtMs: null,
        stopped: true
      });
    }
  }

  /** Call after successful ЧТЗ POST /meetings/start (numeric control path). */
  markSessionStarted(meetingId: number): void {
    const now = Date.now();
    const prev = this.rows.get(meetingId);
    this.rows.set(meetingId, {
      lastPingAtMs: now,
      sessionStartedAtMs: prev?.sessionStartedAtMs ?? now,
      stopped: false
    });
  }

  touchPing(meetingId: number): void {
    const now = Date.now();
    const prev = this.rows.get(meetingId);
    this.rows.set(meetingId, {
      lastPingAtMs: now,
      sessionStartedAtMs: prev?.sessionStartedAtMs ?? null,
      stopped: prev?.stopped ?? false
    });
  }

  getPingStatus(meetingId: number): "meeting_in_progress" | "meeting_stopped" {
    const row = this.rows.get(meetingId);
    if (!row || row.stopped) {
      return "meeting_stopped";
    }
    return "meeting_in_progress";
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    const tick = (): void => {
      const now = Date.now();
      for (const [meetingId, row] of this.rows) {
        if (row.stopped) continue;
        if (!row.sessionStartedAtMs) continue;
        if (now - row.lastPingAtMs > env.JOBAI_CANDIDATE_ABSENT_MS) {
          logger.info({ meetingId }, "candidate absent threshold exceeded — scheduling deinit");
          this.onAutoDeinit?.(meetingId, "candidate_absent");
          row.stopped = true;
          continue;
        }
        if (now - row.sessionStartedAtMs > env.JOBAI_MAX_MEETING_WALL_MS) {
          logger.info({ meetingId }, "max meeting wall time exceeded — scheduling deinit");
          this.onAutoDeinit?.(meetingId, "max_wall_time");
          row.stopped = true;
        }
      }
    };
    this.sweepTimer = setInterval(tick, env.JOBAI_LK_PRESENCE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }
}
