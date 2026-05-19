# CHТЗ #3 — OpenAI Realtime TTS → ffmpeg → RTMP ingress

Isolated transport adapter: assistant audio from OpenAI Realtime (`response.audio.delta`, PCM16 mono @ 24 kHz) is written to ffmpeg stdin and published to the LiveKit RTMP ingress URL from numeric control `POST /meetings/start` as `agentRTMPURL`. No avatar runtime, no LiveKit SDK, no `StreamAgentPublisher` on this path.

## Pipeline

```
POST /meetings/start { agentRTMPURL }
  → rtmpTtsSessionManager.start (ffmpeg)
  → rtmpTtsAudioTap.register(internalMeetingId)

OpenAI Realtime datachannel (response.audio.delta)
  → POST /realtime/session/:id/events
  → rtmpTtsAudioTap.handleRealtimeEvent
  → rtmpTtsSessionManager.writePcm16
  → ffmpeg stdin (s16le 24k mono)
  → AAC 48k → FLV → RTMP/RTMPS URL
```

When `agentRTMPURL` is set on control start, `avatarRuntime.startForMeeting` is **not** called. Meeting orchestrator still starts for the OpenAI session; only avatar/ARACHNE/A2F paths are skipped.

## ffmpeg

```bash
ffmpeg -hide_banner -loglevel info \
  -f s16le -ar 24000 -ac 1 -i pipe:0 \
  -c:a aac -b:a 128k -ar 48000 -ac 1 \
  -f flv "${agentRTMPURL}"
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `RTMP_INGRESS_ENABLED` | `true` | Set `false` to disable spawning ffmpeg |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary on the host |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | REST TTS model for ingress smoke (`/audio/speech`, `response_format=pcm`) |
| `OPENAI_TTS_VOICE` | *(falls back to `OPENAI_REALTIME_VOICE`)* | REST TTS voice for smoke |
| `RTMP_INGRESS_SMOKE_ENABLED` | `false` | **TEMP** — after `publisher_spawned`, loop OpenAI speech PCM → ffmpeg stdin (no frontend) |
| `RTMP_INGRESS_SMOKE_INTERVAL_MS` | `4500` | Tick interval for smoke loop (3–15 s) |

### Ingress runtime smoke (TEMP)

When `RTMP_INGRESS_SMOKE_ENABLED=true` and `RTMP_INGRESS_ENABLED=true`, after a successful publisher spawn the gateway calls OpenAI `POST /audio/speech` with `response_format=pcm` every ~4.5 s and writes PCM via `rtmpTtsAudioTap.writePcm16Direct` → `rtmpTtsSessionManager.writePcm16`. Stdin stays open; the publisher is not restarted between ticks. Logs: `rtmp_ingress_smoke_*`, `rtmp_tts_first_pcm_write`, snapshot `bytesWritten` / `chunksWritten` / `lastWriteAt` / `lastStderr`.

`JOBAI_AI_AGENT_API_BASE_URL` is optional: when set, start may forward to JobAI AI-agent API; RTMP publish uses `agentRTMPURL` from the control request directly.

## Droplet deploy

```bash
apt install -y ffmpeg && cd /root/NULLXES_HR_BACKEND && git pull && npm install && npm run build && sudo systemctl restart nullxes-hr-backend
```

Ensure `.env` does not set `RTMP_INGRESS_ENABLED=false` unless RTMP is intentionally off.

## Smoke test (on droplet)

```bash
curl -sS http://127.0.0.1:8080/health && echo
which ffmpeg && ffmpeg -version | head -1

curl -sS -X POST http://127.0.0.1:8080/meetings/start \
  -H "Authorization: Bearer <meetingControlKey>" \
  -H "Content-Type: application/json" \
  -d '{"meetingId":123,"agentRTMPURL":"rtmps://ingress.example/live/stream-key"}'

sudo journalctl -u nullxes-hr-backend -n 50 --no-pager | grep -i "rtmp tts"

curl -sS -X POST http://127.0.0.1:8080/meetings/stop \
  -H "Authorization: Bearer <meetingControlKey>" \
  -H "Content-Type: application/json" \
  -d '{"meetingId":123,"stopReason":"manual"}'
```

Expected errors:

- `rtmp_publish_failed` — ffmpeg missing, bad URL, or ingress rejected connection at startup
- `rtmp_receiver_not_ready` — only when `JOBAI_AI_AGENT_API_BASE_URL` forward fails with that specific error
