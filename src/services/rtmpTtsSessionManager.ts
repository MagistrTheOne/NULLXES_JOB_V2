import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../config/env";
import { logger } from "../logging/logger";

export interface RtmpTtsSession {
  meetingId: number;
  ffmpeg: ChildProcess;
  rtmpUrl: string;
  startedAt: number;
}

export type RtmpTtsSessionStatus =
  | "missing_agent_rtmp_url"
  | "disabled"
  | "starting"
  | "spawned"
  | "exited"
  | "failed"
  | "stopped";

export interface RtmpTtsSessionSnapshot {
  meetingId: number;
  status: RtmpTtsSessionStatus;
  active: boolean;
  rtmpUrl?: string;
  startedAt?: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastError?: string;
  lastStderr?: string;
}

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

  isEnabled(): boolean {
    return env.RTMP_INGRESS_ENABLED;
  }

  isActive(meetingId: number): boolean {
    return this.sessions.has(meetingId);
  }

  getSnapshot(meetingId: number): RtmpTtsSessionSnapshot {
    const session = this.sessions.get(meetingId);
    if (session) {
      const existing = this.snapshots.get(meetingId);
      return {
        meetingId,
        status: existing?.status === "starting" ? "starting" : "spawned",
        active: true,
        rtmpUrl: truncateRtmpUrl(session.rtmpUrl),
        startedAt: session.startedAt,
        updatedAt: existing?.updatedAt ?? session.startedAt,
        lastStderr: existing?.lastStderr,
        lastError: existing?.lastError
      };
    }
    return (
      this.snapshots.get(meetingId) ?? {
        meetingId,
        status: "missing_agent_rtmp_url",
        active: false,
        updatedAt: Date.now()
      }
    );
  }

  async start(input: { meetingId: number; rtmpUrl: string }): Promise<void> {
    if (!this.isEnabled()) {
      this.setSnapshot(input.meetingId, {
        status: "disabled",
        active: false,
        lastError: "rtmp_ingress_disabled"
      });
      throw new Error("rtmp_ingress_disabled");
    }

    await this.stop(input.meetingId);
    this.setSnapshot(input.meetingId, {
      status: "starting",
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
      proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setSnapshot(input.meetingId, {
        status: "failed",
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

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 4096) {
          stderr = stderr.slice(-4096);
        }
        this.mergeSnapshot(input.meetingId, {
          lastStderr: stderr.trim()
        });
        logger.info({ meetingId: input.meetingId, rtmp: rtmpSafe, ffmpeg: text.trim() }, "rtmp tts ffmpeg");
      });

      proc.on("error", (err) => {
        this.setSnapshot(input.meetingId, {
          status: "failed",
          active: false,
          rtmpUrl: rtmpSafe,
          lastError: err.message,
          lastStderr: stderr.trim() || undefined
        });
        fail(`ffmpeg spawn failed: ${err.message}`);
      });

      proc.stdin?.on("error", () => {
        /* expected when stdin is closed on stop */
      });

      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 200);

      proc.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        if (!settled) {
          const message = `ffmpeg exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"}): ${
            stderr.trim() || "no stderr"
          }`;
          this.setSnapshot(input.meetingId, {
            status: "failed",
            active: false,
            rtmpUrl: rtmpSafe,
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
          this.setSnapshot(input.meetingId, {
            status: "exited",
            active: false,
            rtmpUrl: rtmpSafe,
            startedAt: current.startedAt,
            exitCode: code,
            signal,
            lastStderr: stderr.trim() || undefined
          });
          logger.warn(
            { meetingId: input.meetingId, rtmp: rtmpSafe, code, signal, ffmpeg: stderr.trim() || undefined },
            "rtmp tts ffmpeg exited"
          );
        }
      });
    });

    this.sessions.set(input.meetingId, {
      meetingId: input.meetingId,
      ffmpeg: proc,
      rtmpUrl: input.rtmpUrl,
      startedAt: Date.now()
    });
    this.setSnapshot(input.meetingId, {
      status: "spawned",
      active: true,
      rtmpUrl: rtmpSafe,
      startedAt: Date.now(),
      lastStderr: stderr.trim() || undefined
    });

    logger.info({ meetingId: input.meetingId, rtmp: rtmpSafe }, "rtmp tts ffmpeg started");
  }

  writePcm16(meetingId: number, chunk: Buffer): void {
    const session = this.sessions.get(meetingId);
    const stdin = session?.ffmpeg.stdin;
    if (!stdin || chunk.length === 0) {
      return;
    }
    try {
      const ok = stdin.write(chunk);
      if (!ok) {
        stdin.once("drain", () => undefined);
      }
    } catch {
      /* stdin closed */
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
      active: false,
      rtmpUrl: truncateRtmpUrl(session.rtmpUrl),
      startedAt: session.startedAt,
      updatedAt: stoppedAt
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
      { meetingId, rtmp: truncateRtmpUrl(session.rtmpUrl) },
      "rtmp tts ffmpeg stopped"
    );
  }

  private setSnapshot(
    meetingId: number,
    patch: Omit<Partial<RtmpTtsSessionSnapshot>, "meetingId"> & { status: RtmpTtsSessionStatus; active: boolean }
  ): void {
    this.snapshots.set(meetingId, {
      meetingId,
      updatedAt: Date.now(),
      ...patch
    });
  }

  private mergeSnapshot(meetingId: number, patch: Partial<Omit<RtmpTtsSessionSnapshot, "meetingId">>): void {
    const current = this.getSnapshot(meetingId);
    this.snapshots.set(meetingId, {
      ...current,
      ...patch,
      updatedAt: Date.now()
    });
  }
}

export const rtmpTtsSessionManager = new RtmpTtsSessionManager();
