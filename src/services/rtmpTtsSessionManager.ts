import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../config/env";
import { logger } from "../logging/logger";

/**
 * LiveKit RTMP ingress lifecycle is owned by JobAI / LiveKit contour.
 * Gateway does not create ingress.
 * Gateway only consumes provided agentRTMPURL
 * and publishes AI audio through ffmpeg.
 *
 * Realtime contour: PCM chunks via stdin stay open for the whole meeting;
 * stdin.end() is only called on explicit stop (not after each audio delta).
 */
export interface RtmpTtsSession {
  meetingId: number;
  ffmpeg: ChildProcess;
  rtmpUrl: string;
  startedAt: number;
  bytesWritten: number;
  chunksWritten: number;
  lastWriteAt?: number;
}

export type RtmpTtsSessionStatus =
  | "missing_agent_rtmp_url"
  | "disabled"
  | "starting"
  | "spawned"
  | "exited"
  | "failed"
  | "stopped";

export type RtmpTtsPublisherState =
  | "missing"
  | "spawning"
  | "active"
  | "exited"
  | "failed"
  | "stopped"
  | "recovered";

export interface RtmpTtsSessionSnapshot {
  meetingId: number;
  status: RtmpTtsSessionStatus;
  state: RtmpTtsPublisherState;
  active: boolean;
  rtmpUrl?: string;
  startedAt?: number;
  exitedAt?: number;
  updatedAt: number;
  exitCode?: number | null;
  pid?: number;
  signal?: NodeJS.Signals | null;
  lastError?: string;
  lastStderr?: string;
  bytesWritten?: number;
  chunksWritten?: number;
  lastWriteAt?: number;
}

export interface RtmpTtsPublisherExitEvent {
  meetingId: number;
  snapshot: RtmpTtsSessionSnapshot;
}

export type RtmpTtsWriteResult = {
  written: boolean;
  reason?: "no_session" | "no_stdin" | "empty_chunk" | "stdin_closed" | "write_failed";
  totalBytesWritten: number;
  chunksWritten: number;
};

/** Redact stream keys / credentials from RTMP URLs for logs. */
export function truncateRtmpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      segments[segments.length - 1] = "***";
      parsed.pathname = `/${segments.join("/")}`;
    }
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username) {
      parsed.username = "***";
    }
    return parsed.toString();
  } catch {
    return url.length > 48 ? `${url.slice(0, 24)}…${url.slice(-8)}` : "***";
  }
}

class RtmpTtsSessionManager {
  private readonly sessions = new Map<number, RtmpTtsSession>();
  private readonly snapshots = new Map<number, RtmpTtsSessionSnapshot>();
  private readonly exitListeners = new Set<(event: RtmpTtsPublisherExitEvent) => void>();

  isEnabled(): boolean {
    return env.RTMP_INGRESS_ENABLED;
  }

  isActive(meetingId: number): boolean {
    return this.sessions.has(meetingId);
  }

  onPublisherExit(listener: (event: RtmpTtsPublisherExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  getSnapshot(meetingId: number): RtmpTtsSessionSnapshot {
    const session = this.sessions.get(meetingId);
    if (session) {
      const existing = this.snapshots.get(meetingId);
      return {
        meetingId,
        status: existing?.status === "starting" ? "starting" : "spawned",
        state: existing?.state === "recovered" ? "recovered" : existing?.status === "starting" ? "spawning" : "active",
        active: true,
        rtmpUrl: truncateRtmpUrl(session.rtmpUrl),
        startedAt: session.startedAt,
        pid: session.ffmpeg.pid,
        updatedAt: existing?.updatedAt ?? session.startedAt,
        lastStderr: existing?.lastStderr,
        lastError: existing?.lastError,
        bytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten,
        lastWriteAt: session.lastWriteAt
      };
    }
    return (
      this.snapshots.get(meetingId) ?? {
        meetingId,
        status: "missing_agent_rtmp_url",
        state: "missing",
        active: false,
        updatedAt: Date.now()
      }
    );
  }

  async start(input: { meetingId: number; rtmpUrl: string; recovered?: boolean }): Promise<void> {
    if (!this.isEnabled()) {
      this.setSnapshot(input.meetingId, {
        status: "disabled",
        state: "missing",
        active: false,
        lastError: "rtmp_ingress_disabled"
      });
      throw new Error("rtmp_ingress_disabled");
    }

    await this.stop(input.meetingId);
    this.setSnapshot(input.meetingId, {
      status: "starting",
      state: "spawning",
      active: false,
      rtmpUrl: truncateRtmpUrl(input.rtmpUrl)
    });

    const ffmpegPath = env.FFMPEG_PATH;
    const args = [
      "-hide_banner",
      "-loglevel",
      "info",
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-f",
      "flv",
      input.rtmpUrl
    ];

    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setSnapshot(input.meetingId, {
        status: "failed",
        state: "failed",
        active: false,
        rtmpUrl: truncateRtmpUrl(input.rtmpUrl),
        lastError: message
      });
      throw new Error(message);
    }

    const rtmpSafe = truncateRtmpUrl(input.rtmpUrl);
    let stderr = "";
    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        void this.stop(input.meetingId).finally(() => reject(new Error(message)));
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        logger.info(
          { meetingId: input.meetingId, rtmp: rtmpSafe, ffmpegStdout: text.slice(0, 500) },
          "rtmp tts ffmpeg stdout"
        );
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 4096) {
          stderr = stderr.slice(-4096);
        }
        this.mergeSnapshot(input.meetingId, {
          lastStderr: stderr.trim()
        });
        logger.info({ meetingId: input.meetingId, rtmp: rtmpSafe, ffmpeg: text.trim() }, "rtmp tts ffmpeg stderr");
      });

      proc.on("error", (err) => {
        this.setSnapshot(input.meetingId, {
          status: "failed",
          state: "failed",
          active: false,
          rtmpUrl: rtmpSafe,
          lastError: err.message,
          lastStderr: stderr.trim() || undefined
        });
        logger.error(
          { meetingId: input.meetingId, rtmp: rtmpSafe, error: err.message },
          "rtmp tts ffmpeg process error"
        );
        fail(`ffmpeg spawn failed: ${err.message}`);
      });

      proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        logger.warn(
          {
            meetingId: input.meetingId,
            rtmp: rtmpSafe,
            code: err.code,
            error: err.message
          },
          "rtmp tts ffmpeg stdin error"
        );
      });

      proc.stdin?.on("close", () => {
        logger.info({ meetingId: input.meetingId, rtmp: rtmpSafe }, "rtmp tts ffmpeg stdin closed");
      });

      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 300);

      proc.on("close", (code, signal) => {
        logger.info(
          { meetingId: input.meetingId, rtmp: rtmpSafe, code, signal, phase: settled ? "runtime" : "startup" },
          "rtmp tts ffmpeg close"
        );
      });

      proc.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        if (!settled) {
          const message = `ffmpeg exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"}): ${
            stderr.trim() || "no stderr"
          }`;
          this.setSnapshot(input.meetingId, {
            status: "failed",
            state: "failed",
            active: false,
            rtmpUrl: rtmpSafe,
            exitedAt: Date.now(),
            exitCode: code,
            signal,
            lastError: message,
            lastStderr: stderr.trim() || undefined
          });
          fail(message);
          return;
        }
        const current = this.sessions.get(input.meetingId);
        if (current?.ffmpeg === proc) {
          this.sessions.delete(input.meetingId);
          const exitedSnapshot = this.setSnapshot(input.meetingId, {
            status: "exited",
            state: "exited",
            active: false,
            rtmpUrl: rtmpSafe,
            startedAt: current.startedAt,
            exitedAt: Date.now(),
            exitCode: code,
            pid: proc.pid,
            signal,
            lastStderr: stderr.trim() || undefined,
            bytesWritten: current.bytesWritten,
            chunksWritten: current.chunksWritten,
            lastWriteAt: current.lastWriteAt
          });
          this.notifyPublisherExit({
            meetingId: input.meetingId,
            snapshot: exitedSnapshot
          });
          logger.warn(
            {
              meetingId: input.meetingId,
              rtmp: rtmpSafe,
              code,
              signal,
              bytesWritten: current.bytesWritten,
              chunksWritten: current.chunksWritten,
              ffmpeg: stderr.trim() || undefined
            },
            "rtmp tts ffmpeg exited"
          );
        }
      });
    });

    const startedAt = Date.now();
    this.sessions.set(input.meetingId, {
      meetingId: input.meetingId,
      ffmpeg: proc,
      rtmpUrl: input.rtmpUrl,
      startedAt,
      bytesWritten: 0,
      chunksWritten: 0
    });
    this.setSnapshot(input.meetingId, {
      status: "spawned",
      state: input.recovered ? "recovered" : "active",
      active: true,
      rtmpUrl: rtmpSafe,
      startedAt,
      pid: proc.pid,
      lastStderr: stderr.trim() || undefined,
      bytesWritten: 0,
      chunksWritten: 0
    });

    logger.info(
      { meetingId: input.meetingId, rtmp: rtmpSafe, pid: proc.pid, recovered: Boolean(input.recovered) },
      "rtmp tts ffmpeg started (stdin open for continuous pcm)"
    );
  }

  writePcm16(meetingId: number, chunk: Buffer): RtmpTtsWriteResult {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return { written: false, reason: "no_session", totalBytesWritten: 0, chunksWritten: 0 };
    }
    const stdin = session.ffmpeg.stdin;
    if (!stdin || chunk.length === 0) {
      return {
        written: false,
        reason: !stdin ? "no_stdin" : "empty_chunk",
        totalBytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten
      };
    }
    if (stdin.destroyed || stdin.writableEnded) {
      return {
        written: false,
        reason: "stdin_closed",
        totalBytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten
      };
    }
    try {
      const ok = stdin.write(chunk);
      if (!ok) {
        stdin.once("drain", () => undefined);
      }
      session.bytesWritten += chunk.length;
      session.chunksWritten += 1;
      session.lastWriteAt = Date.now();
      this.mergeSnapshot(meetingId, {
        bytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten,
        lastWriteAt: session.lastWriteAt
      });
      return {
        written: true,
        totalBytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          meetingId,
          error: message,
          pcmBytes: chunk.length,
          bytesWritten: session.bytesWritten
        },
        "rtmp tts ffmpeg stdin write failed"
      );
      return {
        written: false,
        reason: "write_failed",
        totalBytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten
      };
    }
  }

  async stop(meetingId: number): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    this.sessions.delete(meetingId);

    const proc = session.ffmpeg;
    const stoppedAt = Date.now();
    this.setSnapshot(meetingId, {
      status: "stopped",
      state: "stopped",
      active: false,
      rtmpUrl: truncateRtmpUrl(session.rtmpUrl),
      startedAt: session.startedAt,
      exitedAt: stoppedAt,
      pid: proc.pid,
      updatedAt: stoppedAt,
      bytesWritten: session.bytesWritten,
      chunksWritten: session.chunksWritten,
      lastWriteAt: session.lastWriteAt
    });
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* noop */
        }
        resolve();
      }, 3000);

      const done = (): void => {
        clearTimeout(forceKill);
        resolve();
      };

      if (proc.exitCode !== null) {
        done();
        return;
      }

      proc.once("exit", done);
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      } catch {
        /* noop */
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        done();
      }
    });

    logger.info(
      {
        meetingId,
        rtmp: truncateRtmpUrl(session.rtmpUrl),
        bytesWritten: session.bytesWritten,
        chunksWritten: session.chunksWritten
      },
      "rtmp tts ffmpeg stopped"
    );
  }

  private setSnapshot(
    meetingId: number,
    patch: Omit<Partial<RtmpTtsSessionSnapshot>, "meetingId"> & {
      status: RtmpTtsSessionStatus;
      state?: RtmpTtsPublisherState;
      active: boolean;
    }
  ): RtmpTtsSessionSnapshot {
    const snapshot: RtmpTtsSessionSnapshot = {
      meetingId,
      updatedAt: Date.now(),
      state: this.stateForStatus(patch.status),
      ...patch
    };
    this.snapshots.set(meetingId, snapshot);
    return snapshot;
  }

  private mergeSnapshot(meetingId: number, patch: Partial<Omit<RtmpTtsSessionSnapshot, "meetingId">>): void {
    const current = this.getSnapshot(meetingId);
    this.snapshots.set(meetingId, {
      ...current,
      ...patch,
      updatedAt: Date.now()
    });
  }

  private stateForStatus(status: RtmpTtsSessionStatus): RtmpTtsPublisherState {
    switch (status) {
      case "starting":
        return "spawning";
      case "spawned":
        return "active";
      case "exited":
        return "exited";
      case "failed":
        return "failed";
      case "stopped":
        return "stopped";
      case "missing_agent_rtmp_url":
      case "disabled":
        return "missing";
    }
  }

  private notifyPublisherExit(event: RtmpTtsPublisherExitEvent): void {
    for (const listener of this.exitListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(
          { meetingId: event.meetingId, error: error instanceof Error ? error.message : String(error) },
          "rtmp tts publisher exit listener failed"
        );
      }
    }
  }
}

export const rtmpTtsSessionManager = new RtmpTtsSessionManager();
