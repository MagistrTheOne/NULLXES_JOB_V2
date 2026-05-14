import express, { type Request, type Response } from "express";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./logging/logger";
import { createCorsMiddleware } from "./middleware/cors";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { createReadinessHandler } from "./middleware/health";
import { createMetricsContext } from "./middleware/metrics";
import {
  admissionLimiter,
  jobaiIngestLimiter,
  realtimeSessionLimiter,
  realtimeTokenLimiter
} from "./middleware/rateLimit";
import { requestIdMiddleware } from "./middleware/requestId";
import { createAvatarRouter } from "./routes/avatar.routes";
import { createAvatarGenerateRouter } from "./routes/avatarGenerate.routes";
import { createInterviewsRouter } from "./routes/interviews.routes";
import { createJobAiRouter } from "./routes/jobai.routes";
import {
  createJoinLinksIssueRouter,
  createJoinPublicRouter
} from "./routes/joinLinks.routes";
import { createTzAliasRouter } from "./routes/tzAlias.routes";
import { createJobaiWebrtcProxyRouter } from "./routes/jobaiWebrtcProxy.routes";
import { createMeetingRouter } from "./routes/meeting.routes";
import { createRealtimeRouter } from "./routes/realtime.routes";
import { createOrchestratedRealtimeRouter } from "./routes/orchestratedRealtime.routes";
import { createRuntimeRouter } from "./routes/runtime.routes";
import { createLiveKitRouter } from "./routes/livekit.routes";
import { AvatarClient } from "./services/avatarClient";
import { AvatarStateStore } from "./services/avatarStateStore";
import { PersistedAvatarStateStore } from "./services/persistedAvatarStateStore";
import { StreamProvisioner } from "./services/streamProvisioner";
import { StreamRecordingService } from "./services/streamRecordingService";
import { InterviewSyncService } from "./services/interviewSyncService";
import { InviteLivekitResponseCache } from "./services/inviteLivekitCache";
import { MeetingCandidatePresenceTracker } from "./services/meetingCandidatePresence";
import { createMeetingDeinitRunner } from "./services/meetingDeinitRunner";
import { JobAiClient } from "./services/jobaiClient";
import { JoinTokenSigner } from "./services/joinTokenSigner";
import {
  InMemoryObserverSessionTicketStore,
  RedisObserverSessionTicketStore
} from "./services/observerSessionTicketStore";
import { ObserverSessionTicketSigner } from "./services/observerSessionTicketSigner";
import { MeetingOrchestrator } from "./services/meetingOrchestrator";
import { AvatarRuntimeSessionManager } from "./services/avatarRuntimeSessionManager";
import { MeetingControlWsHub } from "./services/meetingControlWsHub";
import { MeetingStateMachine } from "./services/meetingStateMachine";
import { OpenAIRealtimeClient } from "./services/openaiRealtimeClient";
import { PostMeetingProcessor } from "./services/postMeetingProcessor";
import { RuntimeEventStore } from "./services/runtimeEventStore";
import { RuntimeLeaseStore } from "./services/runtimeLeaseStore";
import { RuntimeSnapshotService } from "./services/runtimeSnapshotService";
import { RuntimeSessionStateStore } from "./services/runtimeSessionStateStore";
import { createStorageBackends, type StorageBackends } from "./services/storageFactory";
import type { InMemorySessionStore } from "./services/sessionStore";
import { WebhookDispatcher } from "./services/webhookDispatcher";
import { WebhookOutbox } from "./services/webhookOutbox";
import { A2FRuntimeService } from "./services/a2f-runtime/a2fRuntimeService";
import { A2FFrameWsHub } from "./services/a2f-runtime/a2fFrameWsHub";
import { InProcessA2FRuntimeClient, type A2FRuntimeClient } from "./services/a2f-runtime/runtimeServiceClient";
import { GpuRuntimeClient } from "./services/a2f-runtime/transport/gpuRuntimeClient";

export interface AppContext {
  app: express.Express;
  sessionStore: InMemorySessionStore;
  webhookDispatcher: WebhookDispatcher;
  postMeetingProcessor: PostMeetingProcessor;
  meetingControlWsHub: MeetingControlWsHub;
  a2fFrameWsHub: A2FFrameWsHub;
  avatarRuntimeSessionManager: AvatarRuntimeSessionManager;
  storage: StorageBackends;
}

export async function createApp(): Promise<AppContext> {
  const app = express();
  const storage = await createStorageBackends();
  const { sessionStore, interviewStore, meetingStore } = storage;

  const openAIClient = new OpenAIRealtimeClient();
  const jobAiClient = new JobAiClient();
  const interviewService = new InterviewSyncService(jobAiClient, interviewStore);
  const meetingStateMachine = new MeetingStateMachine();
  const webhookOutbox = new WebhookOutbox({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  await webhookOutbox.loadAll();
  const postMeetingProcessor = new PostMeetingProcessor(webhookOutbox);
  const webhookDispatcher = new WebhookDispatcher(webhookOutbox);
  const runtimeEvents = new RuntimeEventStore({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  const runtimeLeases = new RuntimeLeaseStore({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  const meetingControlWsHub = new MeetingControlWsHub(interviewService, runtimeEvents);
  const runtimeSessionState = new RuntimeSessionStateStore({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX,
    ttlMs: env.REDIS_SESSION_TTL_MS
  });
  let a2fRuntimeClient: A2FRuntimeClient;
  if (env.A2F_RUNTIME_TRANSPORT === "gpu_pod") {
    a2fRuntimeClient = new GpuRuntimeClient({
      wsBaseUrl: env.A2F_GPU_RUNTIME_WS_URL!,
      podHealthcheckUrl: env.A2F_GPU_RUNTIME_HEALTH_URL,
      heartbeatMs: env.A2F_GPU_HEARTBEAT_MS,
      reconnectBaseMs: env.A2F_GPU_RECONNECT_BASE_MS,
      reconnectMaxMs: env.A2F_GPU_RECONNECT_MAX_MS,
      maxBufferedChunks: env.A2F_GPU_MAX_BUFFERED_CHUNKS
    });
    const gpuRuntimeClient = a2fRuntimeClient as GpuRuntimeClient;
    const pollPodHealth = (): void => {
      void gpuRuntimeClient.checkPodHealth();
    };
    pollPodHealth();
    setInterval(pollPodHealth, 10_000).unref();
  } else {
    const a2fRuntimeService = new A2FRuntimeService();
    a2fRuntimeClient = new InProcessA2FRuntimeClient(a2fRuntimeService);
  }
  const a2fFrameWsHub = new A2FFrameWsHub(a2fRuntimeClient);
  const avatarRuntimeSessionManager = new AvatarRuntimeSessionManager({
    runtimeEvents,
    controlWsHub: meetingControlWsHub,
    sessionState: runtimeSessionState,
    a2fRuntime: a2fRuntimeClient
  });
  meetingControlWsHub.setPauseChangeHandler(({ internalMeetingId, pauseEnabled }) => {
    if (pauseEnabled) {
      avatarRuntimeSessionManager.pause(internalMeetingId, "meeting_control_ws");
      return;
    }
    avatarRuntimeSessionManager.resume(internalMeetingId);
  });
  avatarRuntimeSessionManager.startSweeper();
  const avatarClient = new AvatarClient();
  const avatarStateStore =
    env.STORAGE_BACKEND === "redis" && storage.redis
      ? new PersistedAvatarStateStore({ redis: storage.redis, prefix: env.REDIS_PREFIX, ttlMs: env.REDIS_SESSION_TTL_MS })
      : new AvatarStateStore();
  if (avatarStateStore instanceof PersistedAvatarStateStore) {
    await avatarStateStore.loadAll().catch(() => undefined);
  }
  const streamProvisioner =
    avatarClient.isConfigured() && env.STREAM_API_KEY && env.STREAM_API_SECRET
      ? new StreamProvisioner({
          apiKey: env.STREAM_API_KEY,
          apiSecret: env.STREAM_API_SECRET,
          baseUrl: env.STREAM_BASE_URL
        })
      : undefined;
  const streamRecordingService =
    env.STREAM_API_KEY && env.STREAM_API_SECRET
      ? new StreamRecordingService({
          apiKey: env.STREAM_API_KEY,
          apiSecret: env.STREAM_API_SECRET,
          callType: env.STREAM_CALL_TYPE,
          baseUrl: env.STREAM_BASE_URL
        })
      : undefined;
  const meetingOrchestrator = new MeetingOrchestrator(
    meetingStore,
    meetingStateMachine,
    webhookOutbox,
    postMeetingProcessor,
    avatarClient.isConfigured()
      ? {
          client: avatarClient,
          stateStore: avatarStateStore,
          streamProvisioner,
          streamCallType: env.STREAM_CALL_TYPE
        }
      : undefined,
    runtimeEvents,
    streamRecordingService
  );
  meetingOrchestrator.setQuestionChangeHandler(({ meetingId, questionIndex }) => {
    avatarRuntimeSessionManager.publishCurrentQuestion(meetingId, questionIndex);
  });

  const inviteLivekitCache = new InviteLivekitResponseCache();
  const meetingPresenceTracker = new MeetingCandidatePresenceTracker();
  const meetingDeinitRunner = createMeetingDeinitRunner({
    orchestrator: meetingOrchestrator,
    interviews: interviewService,
    recordings: streamRecordingService,
    controlWsHub: meetingControlWsHub,
    avatarRuntime: avatarRuntimeSessionManager,
    runtimeEvents,
    onPresenceStopped: (id) => {
      meetingPresenceTracker.markStopped(id);
    }
  });
  meetingPresenceTracker.setAutoDeinitHandler((mid) => {
    meetingDeinitRunner.scheduleDeinit(mid, "candidate_leaved");
  });
  meetingPresenceTracker.startSweeper();

  const runtimeSnapshots = new RuntimeSnapshotService({
    meetingStore,
    sessionStore,
    interviewStore,
    avatarStateStore,
    runtimeEvents,
    a2fRuntime: a2fRuntimeClient,
    sessionStateStore: runtimeSessionState,
    streamCallType: env.STREAM_CALL_TYPE
  });

  if (avatarClient.isConfigured()) {
    logger.info(
      {
        avatarPodUrl: env.AVATAR_POD_URL,
        avatarDefaultKey: env.AVATAR_DEFAULT_KEY,
        streamCallType: env.STREAM_CALL_TYPE
      },
      "avatar service wiring enabled — POST /meetings/start will kick off pod"
    );
  } else {
    logger.warn(
      { avatarEnabled: env.AVATAR_ENABLED },
      "avatar service wiring disabled (set AVATAR_ENABLED=true and provide AVATAR_POD_URL/AVATAR_SHARED_TOKEN/STREAM_API_KEY/STREAM_API_SECRET to enable)"
    );
  }

  const metrics = env.METRICS_ENABLED
    ? createMetricsContext({
        sessionStore,
        webhookOutbox,
        redisReconnects: storage.redisReconnects,
        a2fRuntimeStats: () => a2fRuntimeClient.listStats(),
        a2fRuntimeReconnects: () => (a2fRuntimeClient instanceof GpuRuntimeClient ? a2fRuntimeClient.getReconnectsTotal() : 0),
        a2fRuntimeDroppedFrames: () => (a2fRuntimeClient instanceof GpuRuntimeClient ? a2fRuntimeClient.getDroppedFramesTotal() : 0),
        a2fRuntimePodHealth: () => (a2fRuntimeClient instanceof GpuRuntimeClient ? a2fRuntimeClient.getPodHealthState() : 1)
      })
    : undefined;

  app.disable("x-powered-by");
  if (env.RATE_LIMIT_TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use(createCorsMiddleware());
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({
        requestId: req.requestId
      }),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort
        }),
        res: (res) => ({ statusCode: res.statusCode })
      }
    })
  );

  if (metrics) {
    app.use(metrics.middleware);
  }

  // Serve post-processing artifacts (best-effort; directory must exist on host).
  app.use("/artifacts", express.static(env.ARTIFACTS_DIR, { fallthrough: true }));

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  app.get(
    "/health/ready",
    createReadinessHandler({
      redis: storage.redis,
      redisReconnects: storage.redisReconnects,
      webhookOutbox,
      hasOpenAIKey: Boolean(env.OPENAI_API_KEY)
    })
  );

  if (metrics) {
    app.get("/metrics", (req, res, next) => {
      void metrics.handler(req, res).catch(next);
    });
  }

  // ---------------- routers ----------------
  app.use(
    createJobaiWebrtcProxyRouter({
      interviews: interviewService,
      cache: inviteLivekitCache,
      presence: meetingPresenceTracker,
      scheduleDeinit: meetingDeinitRunner.scheduleDeinit
    })
  );

  app.use(
    "/realtime",
    (req, res, next) => {
      // Применяем разные лимиты по подмаршрутам, не оборачивая весь роутер.
      if (req.method === "POST" && req.path === "/session") {
        return realtimeSessionLimiter(req, res, next);
      }
      if (req.method === "GET" && req.path === "/token") {
        return realtimeTokenLimiter(req, res, next);
      }
      next();
    },
    createRealtimeRouter({
      openAIClient,
      sessionStore,
      runtimeEvents,
      avatarRuntime: avatarRuntimeSessionManager
    }),
    createOrchestratedRealtimeRouter({
      runtimeEvents
    })
  );

  app.use(
    "/meetings",
    (req, res, next) => {
      if (req.method === "POST" && /^\/[^/]+\/admission\/candidate(\/|$)/.test(req.path)) {
        return admissionLimiter(req, res, next);
      }
      next();
    },
    createMeetingRouter(meetingOrchestrator, {
      recordings: streamRecordingService,
      interviews: interviewService,
      runtimeEvents,
      controlWsHub: meetingControlWsHub,
      avatarRuntime: avatarRuntimeSessionManager,
      presence: meetingPresenceTracker
    })
  );

  // M3: signed join links (mounted before generic interviews router so that
  // /interviews/:jobAiId/links/* is matched first; existing /interviews/:id GET
  // handlers remain reachable because Express tries handlers in order and
  // joinLinks routes only register /links/* sub-paths).
  if (env.JOIN_TOKEN_SECRET) {
    const joinTokenSigner = new JoinTokenSigner(env.JOIN_TOKEN_SECRET);
    const observerTicketSigner = new ObserverSessionTicketSigner(env.JOIN_TOKEN_SECRET);
    const observerTicketStore = storage.redis
      ? new RedisObserverSessionTicketStore({
          redis: storage.redis,
          prefix: env.REDIS_PREFIX
        })
      : new InMemoryObserverSessionTicketStore();
    const joinLinksDeps = {
      signer: joinTokenSigner,
      store: storage.joinTokenStore,
      observerTicketSigner,
      observerTicketStore,
      resolveMeetingIdByInterview: async (jobAiId: number) => {
        try {
          const snapshot = await runtimeSnapshots.getByInterviewId(jobAiId);
          return snapshot.meetingId;
        } catch {
          return null;
        }
      }
    };
    app.use("/interviews", createJoinLinksIssueRouter(joinLinksDeps));
    app.use("/join", createJoinPublicRouter(joinLinksDeps));
    logger.info({ frontendBaseUrl: env.JOIN_TOKEN_FRONTEND_BASE_URL }, "join links routes enabled");
  } else {
    logger.warn("JOIN_TOKEN_SECRET not set — signed join links routes are disabled");
  }

  app.use("/interviews", createInterviewsRouter(interviewService));
  app.use("/api/v1", createTzAliasRouter(interviewService, jobAiClient));
  app.use("/livekit", createLiveKitRouter({ meetingStore, interviews: interviewService }));
  app.use(
    "/runtime",
    createRuntimeRouter({
      snapshots: runtimeSnapshots,
      events: runtimeEvents,
      leases: runtimeLeases,
      meetingOrchestrator,
      avatarClient,
      avatarStateStore,
      meetingStore,
      avatarRuntime: avatarRuntimeSessionManager,
      sessionState: runtimeSessionState,
      a2fRuntime: a2fRuntimeClient
    })
  );

  app.use("/avatar", createAvatarGenerateRouter({ redis: storage.redis }));
  app.use(
    "/avatar",
    createAvatarRouter({ avatarClient, stateStore: avatarStateStore, meetingOrchestrator, runtimeEvents })
  );
  app.use(
    "/",
    (req, res, next) => {
      if (req.method === "POST" && req.path.startsWith("/jobai/")) {
        return jobaiIngestLimiter(req, res, next);
      }
      if (req.method === "POST" && req.path.startsWith("/webhooks/jobai")) {
        return jobaiIngestLimiter(req, res, next);
      }
      next();
    },
    createJobAiRouter(interviewService, jobAiClient)
  );

  app.get("/ops/webhooks", (_req: Request, res: Response) => {
    res.status(200).json({
      webhookQueue: webhookOutbox.getStats()
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    sessionStore,
    webhookDispatcher,
    postMeetingProcessor,
    meetingControlWsHub,
    a2fFrameWsHub,
    avatarRuntimeSessionManager,
    storage
  };
}
