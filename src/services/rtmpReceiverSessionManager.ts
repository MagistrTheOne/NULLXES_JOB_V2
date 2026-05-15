import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { truncateRtmpUrl } from "./rtmpTtsSessionManager";

export interface RtmpReceiverSession {
  meetingId: number;
  port: number;
  streamKey: string;
  agentReceiverRTMPURL: string;
  ffmpeg: ChildProcess;
  startedAt: number;
}

type PcmListener = (chunk: Buffer) => void;

class RtmpReceiverSessionManager {
  private readonly sessions = new Map<number, RtmpReceiverSession>();
  private readonly portOwners = new Map<number, number>();
  private readonly pcmListeners = new Map<number, Set<PcmListener>>();

  isEnabled(): boolean {
    return env.RTMP_RECEIVER_ENABLED;
  }

  isActive(meetingId: number): boolean {
    return this.sessions.has(meetingId);
  }

  getAgentReceiverUrl(meetingId: number): string | undefined {
    return this.sessions.get(meetingId)?.agentReceiverRTMPURL;
  }

  buildStreamKey(meetingId: number): string {
    return `nullxes-meeting-${meetingId}`;
  }

  buildPublicUrl(port: number, streamKey: string): string {
    const host = env.RTMP_RECEIVER_PUBLIC_HOST.trim();
    const app = env.RTMP_RECEIVER_APP.replace(/^\/+|\/+$/g, "");
    return `rtmp://${host}:${port}/${app}/${streamKey}`;
  }

  onPcm(meetingId: number, listener: PcmListener): () => void {
    const set = this.pcmListeners.get(meetingId) ?? new Set<PcmListener>();
    set.add(listener);
    this.pcmListeners.set(meetingId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.pcmListeners.delete(meetingId);
      }
    };
  }

  private emitPcm(meetingId: number, chunk: Buffer): void {
    const listeners = this.pcmListeners.get(meetingId);
    if (!listeners || chunk.length === 0) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(chunk);
      } catch {
        /* noop */
      }
    }
  }

  private allocatePort(meetingId: number): number {
    for (let port = env.RTMP_RECEIVER_PORT_START; port <= env.RTMP_RECEIVER_PORT_END; port += 1) {
      if (!this.portOwners.has(port)) {
        this.portOwners.set(port, meetingId);
        return port;
      }
    }
    throw new Error("rtmp_receiver_no_ports");
  }

  private releasePort(port: number): void {
    this.portOwners.delete(port);
  }

  async start(input: { meetingId: number }): Promise<RtmpReceiverSession> {
    if (!this.isEnabled()) {
      throw new Error("rtmp_receiver_disabled");
    }

    await this.stop(input.meetingId);

    const port = this.allocatePort(input.meetingId);
    const streamKey = this.buildStreamKey(input.meetingId);
    const listenUrl = `rtmp://0.0.0.0:${port}/${env.RTMP_RECEIVER_APP.replace(/^\/+|\/+$/g, "")}/${streamKey}`;
    const agentReceiverRTMPURL = this.buildPublicUrl(port, streamKey);

    const ffmpegPath = env.FFMPEG_PATH;
    const args = [
      "-hide_banner",
      "-loglevel",
      "info",
      "-listen",
      "1",
      "-timeout",
      String(env.RTMP_RECEIVER_LISTEN_TIMEOUT_US),
      "-i",
      listenUrl,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-f",
      "s16le",
      "pipe:1"
    ];

    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: unknown) {
      this.releasePort(port);
      throw new Error(err instanceof Error ? err.message : String(err));
    }

    const rtmpSafe = truncateRtmpUrl(agentReceiverRTMPURL);
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
        logger.info({ meetingId: input.meetingId, port, rtmp: rtmpSafe, ffmpeg: text.trim() }, "rtmp receiver ffmpeg");
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.emitPcm(input.meetingId, chunk);
      });

      proc.on("error", (err) => {
        fail(`ffmpeg spawn failed: ${err.message}`);
      });

      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 250);

      proc.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        const session = this.sessions.get(input.meetingId);
        if (session?.ffmpeg === proc) {
          this.sessions.delete(input.meetingId);
          this.releasePort(session.port);
          this.pcmListeners.delete(input.meetingId);
          logger.info({ meetingId: input.meetingId, port: session.port, code, signal }, "rtmp receiver ffmpeg exited");
        }
        if (!settled) {
          fail(
            `ffmpeg exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"}): ${
              stderr.trim() || "no stderr"
            }`
          );
        }
      });
    });

    const session: RtmpReceiverSession = {
      meetingId: input.meetingId,
      port,
      streamKey,
      agentReceiverRTMPURL,
      ffmpeg: proc,
      startedAt: Date.now()
    };
    this.sessions.set(input.meetingId, session);
    logger.info({ meetingId: input.meetingId, port, rtmp: rtmpSafe }, "rtmp receiver ffmpeg listening");
    return session;
  }

  async stop(meetingId: number): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    this.sessions.delete(meetingId);
    this.pcmListeners.delete(meetingId);
    this.releasePort(session.port);

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
        proc.kill("SIGTERM");
      } catch {
        done();
      }
    });

    logger.info(
      { meetingId, port: session.port, rtmp: truncateRtmpUrl(session.agentReceiverRTMPURL) },
      "rtmp receiver ffmpeg stopped"
    );
  }
}

export const rtmpReceiverSessionManager = new RtmpReceiverSessionManager();
