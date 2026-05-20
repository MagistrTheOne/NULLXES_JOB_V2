# Staged voice pipeline (STT → LLM → TTS)

Gateway-authoritative interview dialogue when `VOICE_MODE=staged`.

## Flow

```
Candidate mic (browser) or RTMP receiver (Zoom)
  → stagedVoiceTurnRuntime.appendMicPcm16
  → gateway VAD → turn commit
  → POST /v1/audio/transcriptions (WAV per turn)
  → POST /v1/responses (instructions + candidate text + previous_response_id)
  → POST /v1/audio/speech (response_format=pcm, stream optional)
  → rtmpTtsSessionManager.writePcm16 → LiveKit RTMP ingress
```

Legacy `VOICE_MODE=realtime` keeps OpenAI Realtime WebRTC + `response.audio.delta` → `rtmpTtsAudioTap`.

## Env

| Variable | Default | Role |
|----------|---------|------|
| `VOICE_MODE` | `staged` | `realtime` \| `staged` |
| `OPENAI_STT_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | STT leg |
| `OPENAI_LLM_MODEL` | `gpt-4.1-mini` | Responses leg |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | TTS leg |
| `TURN_VAD_SILENCE_MS` | `900` | End-of-turn silence |
| `TURN_VAD_MIN_SPEECH_MS` | `400` | Minimum speech before commit |
| `STT_MAX_TURN_SECONDS` | `60` | Cap turn buffer for STT |
| `VOICE_PCM_BUFFER_MAX_BYTES` | `4MB` | Backpressure cap |
| `VOICE_VAD_RMS_THRESHOLD` | `800` | Energy VAD |

## HTTP API (`/realtime/voice/*`)

- `POST /voice/sessions/start` — `{ meetingId, sessionId, sampleRateHz?, dialogueContext? }`
- `POST /voice/mic/append` — `{ meetingId, pcm16, timestampMs? }` (base64)
- `POST /voice/turn/commit` — force end of candidate turn
- `POST /voice/agent/speak` — `{ meetingId, text }` — HR TTS without STT (greeting)
- `GET /voice/config` — `{ voiceMode }` for frontend bootstrap

## WS (meeting control)

Additional `eventType` values when staged:

- `voice_transcript_final` — `{ text, turnId }`
- `voice_agent_text` — `{ text, turnId }`
- `voice_turn_started` — `{ turnId, phase }`

## Runtime events

- `voice.pipeline.mode`
- `voice.turn.stt` / `voice.turn.llm` / `voice.turn.tts`
- `voice.turn.failed`

## Operations

- One in-flight turn per `meetingId`; `turnGeneration` invalidates stale async results.
- Barge-in: new speech during agent TTS → `interrupt()` + abort LLM/TTS `AbortController`.
- Deinit: `meetingDeinitRunner` calls `stagedVoiceTurnRuntime.close`.

## References

- [Realtime and audio](https://developers.openai.com/api/docs/guides/realtime) — use Realtime for speech-to-speech only
- [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) — `/audio/speech` PCM egress
- Speech-to-text — `POST /audio/transcriptions`
