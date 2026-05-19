import { env } from "./config/env";
import { logger } from "./logging/logger";
import { createApp } from "./app";
import { rtmpIngressSmokeLoop } from "./services/rtmpIngressSmokeLoop";

async function main(): Promise<void> {
  const { app, sessionStore, webhookDispatcher, postMeetingProcessor, meetingControlWsHub, a2fFrameWsHub, storage } =
    await createApp();
  sessionStore.startSweeper();
  webhookDispatcher.start();
  postMeetingProcessor.start();

  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        storageBackend: env.STORAGE_BACKEND,
        metricsEnabled: env.METRICS_ENABLED,
        rateLimitEnabled: env.RATE_LIMIT_ENABLED
      },
      "realtime gateway listening"
    );
  });
  meetingControlWsHub.attach(server);
  a2fFrameWsHub.attach(server);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "graceful shutdown started");
    rtmpIngressSmokeLoop.stopAll("shutdown");
    sessionStore.stopSweeper();
    webhookDispatcher.stop();
    postMeetingProcessor.stop();
    server.close((err) => {
      void (async () => {
        try {
          await storage.close();
        } catch (closeError) {
          logger.warn({ err: closeError }, "storage close failed");
        }
        if (err) {
          logger.error({ err }, "error during shutdown");
          process.exit(1);
          return;
        }
        logger.info("server shutdown complete");
        process.exit(0);
      })();
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
});
