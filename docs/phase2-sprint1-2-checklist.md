# Phase 2 Sprint 1-2 Verification Checklist

## Build Safety

- `npm run typecheck`
- `npm run build`

## Runtime Preconditions

- `VIDEO_ENGINE=arachne`
- `AVATAR_POD_URL` configured
- `AVATAR_FRAMES_PATH=/v1/realtime/avatar_frames`
- `STREAM_API_KEY` and `STREAM_API_SECRET` configured

## Runtime Smoke

- Start gateway and create/start a meeting.
- Trigger assistant response (audio delta flow).
- Run:
  - `node scripts/phase2-sprint1-2-smoke.mjs`
  - `MEETING_ID=<canonical meeting id, e.g. nullxes-meeting-123> node scripts/phase2-sprint1-2-smoke.mjs`
- Verify `/runtime/:meetingId/avatar-stats` returns:
  - `orchestrator.activeSpeaker`
  - `orchestrator.duplexMode`
  - `orchestrator.videoAudioSource`
  - `engine.micRingSizeMs`
  - `engine.ttsRingSizeMs`
  - `engine.underrunCount`
  - `engine.audioQueueDropCount`
  - `engine.chunkViolationCount`

## Pause/Resume/Interrupt

- Send WS pause command (`set_pause_enabled=true`) and confirm:
  - `ai_agent` becomes `paused`
  - no stale speaking resumes during pause
- Resume and confirm `ai_agent` back to `listening` then `speaking` on next response.

## Queue and Chunk Policy

- Feed oversized audio delta and confirm chunk violations counter increments.
- Under burst load, confirm queue is bounded (~`AVATAR_AUDIO_QUEUE_BUDGET_MS`) and drops are counted.
- Confirm no unbounded ring growth over several minutes.

