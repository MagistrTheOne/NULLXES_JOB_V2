import { env } from "../config/env";

type CacheEntry = { expiresAtMs: number; payload: Record<string, unknown> };

/** ЧТЗ п.1.1 — in-memory cache without persistence (per process). */
export class InviteLivekitResponseCache {
  private readonly map = new Map<string, CacheEntry>();

  get(inviteToken: string): Record<string, unknown> | undefined {
    const e = this.map.get(inviteToken);
    if (!e) return undefined;
    if (Date.now() > e.expiresAtMs) {
      this.map.delete(inviteToken);
      return undefined;
    }
    return e.payload;
  }

  set(inviteToken: string, payload: Record<string, unknown>): void {
    this.map.set(inviteToken, {
      expiresAtMs: Date.now() + env.JOBAI_INVITE_LK_CACHE_TTL_MS,
      payload
    });
    if (this.map.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this.map) {
        if (v.expiresAtMs < now) this.map.delete(k);
      }
    }
  }
}
