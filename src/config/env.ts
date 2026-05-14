import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
    }
    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  // Realtime built-in voices per OpenAI docs include:
  // alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
  // Default to a feminine sounding voice for HR interviewer tone.
  OPENAI_REALTIME_VOICE: z.string().default("coral"),
  OPENAI_TURN_DETECTION_ENABLED: envBoolean(false),
  OPENAI_TURN_DETECTION_TYPE: z.enum(["server_vad"]).default("server_vad"),
  OPENAI_TURN_DETECTION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  OPENAI_TURN_DETECTION_PREFIX_PADDING_MS: z.coerce.number().int().min(0).default(450),
  OPENAI_TURN_DETECTION_SILENCE_DURATION_MS: z.coerce.number().int().min(100).default(900),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  SESSION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  SDP_MAX_BYTES: z.coerce.number().int().positive().default(200000),
  OPENAI_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  JOBAI_WEBHOOK_ENABLED: envBoolean(false),
  JOBAI_WEBHOOK_URL: z.string().url().optional(),
  JOBAI_WEBHOOK_SECRET: z.string().min(16).optional(),
  JOBAI_WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOBAI_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  JOBAI_API_BASE_URL: z.string().url().optional(),
  JOBAI_API_AUTH_MODE: z.enum(["none", "bearer", "basic"]).default("none"),
  JOBAI_API_TOKEN: z.string().min(1).optional(),
  JOBAI_API_BASIC_USER: z.string().min(1).optional(),
  JOBAI_API_BASIC_PASSWORD: z.string().min(1).optional(),
  JOBAI_INGEST_SECRET: z.string().min(8).optional(),
  NULLXES_INTERVIEW_FRONTEND_BASE_URL: z.string().url().default("https://dev.job-ai.ru/interview"),
  NULLXES_INTERVIEW_LOOKUP_AUTH_TOKEN: z.string().min(8).optional(),
  NULLXES_AI_WS_URL: z.string().min(1).default("ws://test.com"),
  NULLXES_AI_WS_URL_TEMPLATE: z.string().min(1).optional(),
  STORAGE_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().url().optional(),
  REDIS_PREFIX: z.string().default("nullxes:hr-ai"),
  REDIS_SESSION_TTL_MS: z.coerce.number().int().positive().default(86400000),
  REDIS_RECONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(30000),
  REDIS_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  REDIS_COMMAND_QUEUE_LIMIT: z.coerce.number().int().positive().default(100),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  METRICS_ENABLED: envBoolean(true),
  RATE_LIMIT_ENABLED: envBoolean(true),
  RATE_LIMIT_TRUST_PROXY: envBoolean(true),
  CANDIDATE_ADMISSION_REJOIN_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  MEETING_STALE_TIMEOUT_MS: z.coerce.number().int().positive().default(14_400_000),
  MEETING_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // M3: signed candidate / spectator join links
  // JOIN_TOKEN_SECRET is required only when join-link issuance is in use; we keep
  // it optional in the schema so existing droplet boots don't break before the
  // operator generates a secret. Issuance routes refuse to start without it.
  JOIN_TOKEN_SECRET: z.string().min(32).optional(),
  JOIN_TOKEN_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  OBSERVER_SESSION_TICKET_TTL_MS: z.coerce.number().int().positive().default(120_000),
  JOIN_TOKEN_FRONTEND_BASE_URL: z.string().url().default("http://localhost:3000"),
  JOIN_TOKEN_AUDIT_LIMIT: z.coerce.number().int().positive().default(100),
  // Avatar service (RunPod GPU pod / ARACHNE-X worker).
  AVATAR_ENABLED: envBoolean(false),
  AVATAR_POD_URL: z.string().url().optional(),
  AVATAR_SHARED_TOKEN: z.string().min(16).optional(),
  AVATAR_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  AVATAR_FRAMES_PATH: z.string().min(1).default("/v1/realtime/avatar_frames"),
  AVATAR_FRAMES_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  NULLXES_INFERENCE_SERVICE_KEY: z.string().min(1).optional(),
  NULLXES_AVATAR_INFERENCE_SERVICE_KEY: z.string().min(1).optional(),
  LONGCAT_INFERENCE_SERVICE_KEY: z.string().min(1).optional(),
  AVATAR_DEFAULT_KEY: z.string().min(1).default("anna"),
  AVATAR_DEFAULT_EMOTION: z.string().min(1).default("neutral"),
  AVATAR_REFERENCE_IMAGE_URL: z.string().url().optional(),
  AVATAR_DUPLEX_MODE: z.enum(["single_assistant", "duplex"]).default("single_assistant"),
  AVATAR_VIDEO_AUDIO_SOURCE: z.enum(["tts", "mic", "auto"]).default("tts"),
  AVATAR_VIDEO_MODEL: z.enum(["wan", "ltx"]).default("wan"),
  AVATAR_LTX_CHECKPOINT: z.string().min(1).default("Lightricks/LTX-2.3"),
  AVATAR_LTX_VARIANT: z.string().min(1).default("ltx-2.3-22b-distilled-1.1"),
  AVATAR_LTX_WIDTH: z.coerce.number().int().positive().default(832),
  AVATAR_LTX_HEIGHT: z.coerce.number().int().positive().default(480),
  AVATAR_LTX_NUM_FRAMES: z.coerce.number().int().positive().default(25),
  AVATAR_LTX_FPS: z.coerce.number().int().positive().default(25),
  AVATAR_LTX_STEPS: z.coerce.number().int().positive().default(8),
  AVATAR_LTX_CFG: z.coerce.number().min(0).default(1.0),
  AVATAR_LTX_SEED: z.coerce.number().int().optional(),
  AVATAR_SPEAKER_HOLD_MS: z.coerce.number().int().min(0).max(10_000).default(600),
  AVATAR_MIC_VAD_RMS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.02),
  AVATAR_MIC_VAD_SILENCE_MS: z.coerce.number().int().min(0).max(10_000).default(450),
  // Stream SFU (used by avatar pod and frontend; gateway only forwards keys to pod)
  STREAM_API_KEY: z.string().min(1).optional(),
  STREAM_API_SECRET: z.string().min(1).optional(),
  STREAM_BASE_URL: z.string().url().default("https://video.stream-io-api.com"),
  STREAM_CALL_TYPE: z.string().min(1).default("default"),
  // LiveKit (optional parallel SFU/agent transport)
  LIVEKIT_URL: z.string().min(1).optional(),
  /** Optional override for RoomServiceClient host (https URL). If unset, derived from LIVEKIT_URL. */
  LIVEKIT_HTTP_HOST: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  /** When set, ЧТЗ п.2.2/2.3 for meetings/start|stop are forwarded to this base URL with Bearer meetingControlKey. */
  JOBAI_AI_AGENT_API_BASE_URL: z.string().url().optional(),
  JOBAI_AI_AGENT_START_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** ЧТЗ п.4.1 — max time without client ping before auto-deinit (proxy). */
  JOBAI_CANDIDATE_ABSENT_MS: z.coerce.number().int().positive().default(300_000),
  /** ЧТЗ п.4.1 — max wall time for meeting session on proxy. */
  JOBAI_MAX_MEETING_WALL_MS: z.coerce.number().int().positive().default(3_600_000),
  JOBAI_DEINIT_AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  JOBAI_DEINIT_AI_DELAY_MS: z.coerce.number().int().positive().default(30_000),
  /** In-memory cache TTL for п.1.1 get-interview-livekit-data (inviteToken → 2.1 payload). */
  JOBAI_INVITE_LK_CACHE_TTL_MS: z.coerce.number().int().positive().default(120_000),
  JOBAI_LK_PRESENCE_SWEEP_MS: z.coerce.number().int().positive().default(30_000),
  // Post-processing artifacts (assistant audio capture + optional merge)
  ARTIFACTS_DIR: z.string().min(1).default("/var/lib/nullxes-hr/artifacts"),
  ASSISTANT_AUDIO_MAX_BYTES: z.coerce.number().int().positive().default(25_000_000)
  ,
  // Inference worker (RunPod) - inference-only avatar generator.
  RUNPOD_WORKER_URL: z.string().url().optional(),
  RUNPOD_WORKER_MODE: z.enum(["sync", "async"]).default("async"),
  RUNPOD_WORKER_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  RUNPOD_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  RUNPOD_WORKER_MAX_INFLIGHT: z.coerce.number().int().min(1).max(8).default(1),
  RUNPOD_WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  RUNPOD_WORKER_RETURN_FRAMES: envBoolean(true),
  /** Canonical realtime avatar engine. `core` aliases are normalized to `arachne` when sent to the pod. */
  VIDEO_ENGINE: z.enum(["none", "behavior_static", "arachne", "arachne_ultra_avatar", "arachne_ultra_video", "nullxes", "longcat", "core"]).default("none"),
  /** Legacy env name kept for operators; production values are narrowed to ARACHNE/static/none. */
  VIDEO_MODEL: z.enum(["none", "behavior_static", "arachne", "arachne_ultra_avatar", "arachne_ultra_video"]).default("none"),
  AVATAR_VIDEO_ENABLED: envBoolean(true),
  AVATAR_VIDEO_DEGRADED_FALLBACK: z.enum(["static", "none"]).default("static"),
  AVATAR_AUDIO_CHUNK_TARGET_MS: z.coerce.number().int().min(20).max(40).default(20),
  AVATAR_AUDIO_CHUNK_MAX_MS: z.coerce.number().int().min(20).max(40).default(40),
  AVATAR_AUDIO_QUEUE_BUDGET_MS: z.coerce.number().int().min(80).max(2_000).default(200),
  ANAM_ENABLED: envBoolean(false),
  A2F_RUNTIME_ENABLED: envBoolean(true),
  A2F_RUNTIME_TRANSPORT: z.enum(["inprocess", "gpu_pod"]).default("inprocess"),
  A2F_GPU_RUNTIME_WS_URL: z.string().url().optional(),
  A2F_GPU_RUNTIME_HEALTH_URL: z.string().url().optional(),
  A2F_GPU_HEARTBEAT_MS: z.coerce.number().int().positive().default(5000),
  A2F_GPU_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(500),
  A2F_GPU_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(10000),
  A2F_GPU_MAX_BUFFERED_CHUNKS: z.coerce.number().int().min(8).max(4096).default(128),
  A2F_RUNTIME_TARGET_FPS: z.coerce.number().int().min(10).max(120).default(30),
  A2F_RUNTIME_WINDOW_MS: z.coerce.number().int().min(20).max(120).default(40),
  A2F_RUNTIME_HOP_MS: z.coerce.number().int().min(10).max(80).default(20),
  A2F_RUNTIME_MAX_QUEUE_MS: z.coerce.number().int().min(80).max(2_000).default(200),
  /** External GPU batch avatar runtime (orchestration only; no inference in gateway). */
  RUNPOD_RUNTIME_URL: z.string().url().optional(),
  /** Default Luna reference path on the GPU filesystem (sent in hello / session). */
  LUNA_REF_IMAGE_PATH: z.string().min(1).default("/workspace/test_assets/luna.jpg"),
  RUNPOD_GENERATE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AVATAR_GENERATE_JOB_TTL_MS: z.coerce.number().int().positive().default(86400000),
  /** Wall clock from `startedAt` after which the job fails with `generation_timeout`. */
  AVATAR_GENERATE_WALL_MS: z.coerce.number().int().positive().default(180_000),
  /** If a job stays in `processing` longer than this, stale sweeper marks it failed (`processing_stale`). */
  AVATAR_GENERATE_PROCESSING_STALE_MS: z.coerce.number().int().positive().default(600_000),
  AVATAR_GENERATE_RETRY_BACKOFF_1_MS: z.coerce.number().int().positive().default(2000),
  AVATAR_GENERATE_RETRY_BACKOFF_2_MS: z.coerce.number().int().positive().default(5000),
  AVATAR_GENERATE_STALE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Alias for Stream credentials (falls back to STREAM_API_KEY / STREAM_API_SECRET). */
  GETSTREAM_API_KEY: z.string().min(1).optional(),
  GETSTREAM_SECRET: z.string().min(1).optional()
}).superRefine((values, ctx) => {
  if (values.JOBAI_WEBHOOK_ENABLED) {
    if (!values.JOBAI_WEBHOOK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOBAI_WEBHOOK_URL"],
        message: "JOBAI_WEBHOOK_URL is required when JOBAI_WEBHOOK_ENABLED=true"
      });
    }

    if (!values.JOBAI_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOBAI_WEBHOOK_SECRET"],
        message: "JOBAI_WEBHOOK_SECRET is required when JOBAI_WEBHOOK_ENABLED=true"
      });
    }
  }

  if (values.JOBAI_API_AUTH_MODE === "bearer" && !values.JOBAI_API_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JOBAI_API_TOKEN"],
      message: "JOBAI_API_TOKEN is required when JOBAI_API_AUTH_MODE=bearer"
    });
  }

  if (
    values.JOBAI_API_AUTH_MODE === "basic" &&
    (!values.JOBAI_API_BASIC_USER || !values.JOBAI_API_BASIC_PASSWORD)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JOBAI_API_BASIC_USER"],
      message: "JOBAI_API_BASIC_USER and JOBAI_API_BASIC_PASSWORD are required when JOBAI_API_AUTH_MODE=basic"
    });
  }

  if (values.STORAGE_BACKEND === "redis" && !values.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REDIS_URL"],
      message: "REDIS_URL is required when STORAGE_BACKEND=redis"
    });
  }

  if (values.AVATAR_ENABLED) {
    if (!values.AVATAR_POD_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AVATAR_POD_URL"],
        message: "AVATAR_POD_URL is required when AVATAR_ENABLED=true"
      });
    }
    if (!values.AVATAR_SHARED_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AVATAR_SHARED_TOKEN"],
        message: "AVATAR_SHARED_TOKEN is required when AVATAR_ENABLED=true"
      });
    }
    if (!values.STREAM_API_KEY || !values.STREAM_API_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STREAM_API_KEY"],
        message: "STREAM_API_KEY and STREAM_API_SECRET are required when AVATAR_ENABLED=true (gateway forwards them to the pod)"
      });
    }
  }

  if (values.A2F_RUNTIME_TRANSPORT === "gpu_pod" && !values.A2F_GPU_RUNTIME_WS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["A2F_GPU_RUNTIME_WS_URL"],
      message: "A2F_GPU_RUNTIME_WS_URL is required when A2F_RUNTIME_TRANSPORT=gpu_pod"
    });
  }

  const runtimeEngine = values.VIDEO_ENGINE !== "none" ? values.VIDEO_ENGINE : values.VIDEO_MODEL;
  if (
    ["arachne", "arachne_ultra_avatar", "arachne_ultra_video", "nullxes", "longcat", "core"].includes(runtimeEngine) &&
    !values.AVATAR_POD_URL?.trim()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AVATAR_POD_URL"],
      message: "AVATAR_POD_URL is required when VIDEO_ENGINE=arachne"
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formattedErrors = parsed.error.errors
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${formattedErrors}`);
}

export const env = parsed.data;
export type AppEnv = typeof env;

export function resolveGetstreamApiCredentials(): { apiKey: string | undefined; apiSecret: string | undefined } {
  return {
    apiKey: env.GETSTREAM_API_KEY ?? env.STREAM_API_KEY,
    apiSecret: env.GETSTREAM_SECRET ?? env.STREAM_API_SECRET
  };
}

export type RuntimeVideoEngine =
  | "none"
  | "behavior_static"
  | "arachne"
  | "arachne_ultra_avatar"
  | "arachne_ultra_video";

export function resolveRuntimeVideoEngine(): RuntimeVideoEngine {
  const configured = env.VIDEO_ENGINE !== "none" ? env.VIDEO_ENGINE : env.VIDEO_MODEL;
  if (configured === "behavior_static") return "behavior_static";
  if (configured === "arachne_ultra_avatar" || configured === "arachne_ultra_video") return configured;
  if (configured === "arachne" || configured === "nullxes" || configured === "longcat" || configured === "core") {
    return "arachne";
  }
  return "none";
}

export function resolveArachnePodEngine(): "arachne" | "arachne_ultra_avatar" | "arachne_ultra_video" {
  const engine = resolveRuntimeVideoEngine();
  if (engine === "arachne_ultra_avatar" || engine === "arachne_ultra_video") return engine;
  return "arachne";
}

export function resolveAvatarInferenceServiceKey(): string | undefined {
  return (
    env.NULLXES_INFERENCE_SERVICE_KEY?.trim() ||
    env.NULLXES_AVATAR_INFERENCE_SERVICE_KEY?.trim() ||
    env.LONGCAT_INFERENCE_SERVICE_KEY?.trim() ||
    undefined
  );
}
