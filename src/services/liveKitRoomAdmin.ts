import { RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { deriveLiveKitHttpHost } from "./interviewInviteResponse";

function client(): RoomServiceClient | null {
  const host = deriveLiveKitHttpHost();
  const key = env.LIVEKIT_API_KEY?.trim();
  const secret = env.LIVEKIT_API_SECRET?.trim();
  if (!host || !key || !secret) {
    return null;
  }
  return new RoomServiceClient(host, key, secret);
}

export async function ensureLiveKitRoom(roomName: string): Promise<{ created: boolean }> {
  const c = client();
  if (!c) {
    throw new Error("livekit_not_configured");
  }
  const existing = await c.listRooms([roomName]).catch((err: unknown) => {
    logger.warn({ err, roomName }, "livekit listRooms failed");
    return [] as { name: string }[];
  });
  if (existing.some((r) => r.name === roomName)) {
    return { created: false };
  }
  await c.createRoom({
    name: roomName,
    emptyTimeout: 600,
    departureTimeout: 120
  });
  return { created: true };
}

export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  const c = client();
  if (!c) {
    return;
  }
  try {
    await c.deleteRoom(roomName);
  } catch (err: unknown) {
    logger.warn({ err, roomName }, "livekit deleteRoom failed (may already be gone)");
  }
}
