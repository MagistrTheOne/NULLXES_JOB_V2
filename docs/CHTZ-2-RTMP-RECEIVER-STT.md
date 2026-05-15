# CHТЗ #2 — RTMP receiver → PCM → OpenAI Realtime STT

Inbound transport: JobAI/LiveKit egress publishes candidate audio to a per-meeting RTMP URL returned by `POST /meetings/start` as `agentReceiverRTMPURL`. Gateway ffmpeg listens, decodes to PCM16 mono @ 24 kHz on stdout, forwards chunks to OpenAI Realtime WebSocket STT, and emits control-plane events on `/ws/meeting/:numericMeetingId`.

Outbound TTS → RTMP (CHТЗ #3) remains in [`CHTZ-3-RTMP-INGRESS.md`](./CHTZ-3-RTMP-INGRESS.md) and can run in parallel when `agentRTMPURL` is also supplied.

## Pipeline

```
POST /meetings/start
  → rtmpReceiverSessionManager.start (ffmpeg -listen)
  → rtmpSttBridge.start (OpenAI Realtime WS STT)
  ← agentReceiverRTMPURL

LiveKit egress / ffmpeg publish → agentReceiverRTMPURL
  → ffmpeg stdout PCM s16le 24k mono
  → rtmpSttBridge.ingestPcm
  → input_audio_buffer.append (OpenAI WS)
  → conversation.item.input_audio_transcription.delta
  → meetingControlWsHub.publishSubtitlesDelta
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `RTMP_RECEIVER_ENABLED` | `false` | Enable local ffmpeg RTMP listener + STT bridge |
| `RTMP_RECEIVER_PUBLIC_HOST` | `127.0.0.1` | Hostname/IP published in `agentReceiverRTMPURL` (droplet public IP) |
| `RTMP_RECEIVER_PORT_START` | `19350` | First TCP port for per-meeting listeners |
| `RTMP_RECEIVER_PORT_END` | `19380` | Last TCP port (inclusive) |
| `RTMP_RECEIVER_APP` | `live` | RTMP application name segment |
| `RTMP_RECEIVER_LISTEN_TIMEOUT_US` | `15000000` | ffmpeg listen timeout (µs) |
| `OPENAI_STT_MODEL` | *(OPENAI_REALTIME_MODEL)* | Realtime WS `?model=` query |
| `OPENAI_INPUT_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | `input_audio_transcription.model` |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary |
| `OPENAI_API_KEY` | — | Required for WS STT |

Open firewall inbound TCP for `RTMP_RECEIVER_PORT_START`…`RTMP_RECEIVER_PORT_END` on the droplet.

Example `.env` on JOBAIV2:

```env
RTMP_RECEIVER_ENABLED=true
RTMP_RECEIVER_PUBLIC_HOST=104.248.50.166
RTMP_RECEIVER_PORT_START=19350
RTMP_RECEIVER_PORT_END=19380
RTMP_INGRESS_ENABLED=true
```

## Control WebSocket (`/ws/meeting/:id`)

Auth: `Authorization: Bearer <meetingControlKey>` on upgrade.

**Server → client**

- `activity_mode_changed` — candidate `listening`/`speaking` from OpenAI VAD; ai_agent modes unchanged on this path unless avatar runtime is also active
- `subtitles_delta` — `{ "eventType": "subtitles_delta", "text": "..." }` from STT deltas
- `current_question_changed` — from meeting orchestrator (unchanged)

**Client → server**

- `set_pause_enabled` — `{ "eventType": "set_pause_enabled", "pauseEnabled": true|false }` pauses PCM → OpenAI append

## Errors (`POST /meetings/start`)

| HTTP | errorCode | When |
|------|-----------|------|
| 400 | `rtmp_receiver_not_ready` | ffmpeg/port/OpenAI WS failed to start |
| 400 | `rtmp_publish_failed` | outbound TTS ffmpeg failed (CHТЗ #3) |
| 404 | `meeting_not_found` | unknown numeric meeting |
| 401 | `wrong_meeting_control_key` | Bearer mismatch |

## Smoke test (JOBAIV2 / local)

Prerequisites: `ffmpeg`, `OPENAI_API_KEY`, interview ingested with known `meetingId` + `meetingControlKey`.

```bash
GW=http://127.0.0.1:8080
KEY='<meetingControlKey>'
MID=123456789

# 1) start meeting (receiver URL in response)
curl -sS -X POST "$GW/meetings/start" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"meetingId\":$MID,\"agentRTMPURL\":\"rtmps://example.invalid/outbound\"}" | jq .

RECEIVER='rtmp://104.248.50.166:19350/live/nullxes-meeting-'"$MID"   # or copy agentReceiverRTMPURL from JSON

# 2) publish ~3s test tone to receiver (separate shell)
ffmpeg -hide_banner -f lavfi -i sine=frequency=440:duration=3 \
  -c:a aac -b:a 128k -ar 48000 -ac 1 -f flv "$RECEIVER"

# 3) logs: receiver + STT
sudo journalctl -u nullxes-job-v2 -n 80 --no-pager | grep -E 'rtmp (receiver|stt)|transcript'

# 4) stop
curl -sS -X POST "$GW/meetings/stop" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"meetingId\":$MID,\"stopReason\":\"candidate_leaved\"}"

# 5) no orphan ffmpeg
pgrep -af 'ffmpeg.*rtmp.*nullxes-meeting' || echo 'no orphan ffmpeg'
```

Expected: `agentReceiverRTMPURL` in start JSON; journal lines `rtmp receiver ffmpeg listening`, `rtmp stt bridge started`, `rtmp stt transcript delta` after publish; stop releases port and kills ffmpeg.

## Deploy

```bash
cd /root/NULLXES_JOB_V2
git pull origin V2
npm install && npm run typecheck && npm run build
sudo systemctl restart nullxes-job-v2
```
