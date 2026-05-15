import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../config/env";
import { logger } from "../logging/logger";

export interface RtmpTtsSession {
  meetingId: number;
  ffmpeg: ChildProcess;
  rtmpUrl: string;
  startedAt: number;
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

  isEnabled(): boolean {
    return env.RTMP_INGRESS_ENABLED;
  }

  isActive(meetingId: number): boolean {
    return this.sessions.has(meetingId);
  }

  async start(input: { meetingId: number; rtmpUrl: string }): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error("rtmp_ingress_disabled");
    }

    await this.stop(input.meetingId);

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
      throw new Error(err instanceof Error ? err.message : String(err));
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
        logger.info({ meetingId: input.meetingId, rtmp: rtmpSafe, ffmpeg: text.trim() }, "rtmp tts ffmpeg");
      });

      proc.on("error", (err) => {
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
          fail(
            `ffmpeg exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"}): ${
              stderr.trim() || "no stderr"
            }`
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
}

export const rtmpTtsSessionManager = new RtmpTtsSessionManager();
