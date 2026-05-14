import { logger } from "../logging/logger";
import { deleteLiveKitRoom } from "./liveKitRoomAdmin";
import { liveKitRoomNameForNumericMeetingId } from "./interviewInviteResponse";
import { forwardAiAgentMeetingStopWithRetries, type AiAgentStopReason } from "./jobAiAiAgentForwarder";
import type { MeetingOrchestrator } from "./meetingOrchestrator";
import type { InterviewSyncService } from "./interviewSyncService";
import type { StreamRecordingService } from "./streamRecordingService";
import type { MeetingControlWsHub } from "./meetingControlWsHub";
import type { AvatarRuntimeSessionManager } from "./avatarRuntimeSessionManager";
import type { RuntimeEventStore } from "./runtimeEventStore";

const inFlight = new Set<number>();

function internalMeetingId(meetingId: number): string {
  return `nullxes-meeting-${meetingId}`;
}

function isFinishedMeeting(meeting: { status: string } | undefined): boolean {
  return meeting?.status === "completed" || meeting?.status === "stopped_during_meeting";
}

export interface MeetingDeinitRunnerDeps {
  orchestrator: MeetingOrchestrator;
  interviews: InterviewSyncService;
  recordings?: StreamRecordingService | null;
  controlWsHub?: MeetingControlWsHub;
  avatarRuntime?: AvatarRuntimeSessionManager;
  runtimeEvents?: RuntimeEventStore;
  onPresenceStopped?: (meetingId: number) => void;
}

export function createMeetingDeinitRunner(deps: MeetingDeinitRunnerDeps): {
  scheduleDeinit: (numericMeetingId: number, stopReason: AiAgentStopReason) => void;
} {
  const run = async (numericMeetingId: number, stopReason: AiAgentStopReason): Promise<void> => {
    if (inFlight.has(numericMeetingId)) {
      return;
    }
    inFlight.add(numericMeetingId);
    try {
      const stored = deps.interviews.getInterviewByNumericMeetingId(numericMeetingId);
      const key = stored?.projection.meetingControlKey;
      if (key) {
        await forwardAiAgentMeetingStopWithRetries({
          meetingId: numericMeetingId,
          meetingControlKey: key,
          stopReason
        });
      }

      const internalId = internalMeetingId(numericMeetingId);
      const existing = deps.orchestrator.tryGetMeeting(internalId);
      if (existing && !isFinishedMeeting(existing)) {
        try {
          deps.orchestrator.stopMeeting(internalId, {
            reason: "manual_stop",
            finalStatus: "stopped_during_meeting",
            metadata: {
              stopReason,
              numericMeetingId,
              source: "jobai_webrtc_proxy_deinit"
            }
          });
        } catch (err: unknown) {
          logger.warn({ err, internalId }, "local orchestrator stop during deinit failed");
        }
        if (stored) {
          deps.interviews.attachSession(stored.jobAiId, {
            meetingId: internalId,
            nullxesStatus: "stopped_during_meeting"
          });
          void deps.interviews.transitionStatus(stored.jobAiId, "stopped_during_meeting").catch(() => undefined);
        }
        deps.avatarRuntime?.stop(internalId, stopReason);
      }

      if (deps.recordings?.isConfigured()) {
        try {
          await deps.recordings.stop(internalId);
        } catch (err: unknown) {
          logger.warn({ err, internalId }, "stream recording stop during deinit failed");
        }
      }

      await deleteLiveKitRoom(liveKitRoomNameForNumericMeetingId(numericMeetingId));

      deps.controlWsHub?.closeMeeting(numericMeetingId, "meeting_stopped");
      void deps.runtimeEvents
        ?.append({
          type: "meeting.control.deinit_completed",
          meetingId: internalId,
          actor: "jobai_webrtc_proxy",
          payload: { numericMeetingId, stopReason }
        })
        .catch(() => undefined);

      deps.onPresenceStopped?.(numericMeetingId);
    } finally {
      inFlight.delete(numericMeetingId);
    }
  };

  return {
    scheduleDeinit(numericMeetingId: number, stopReason: AiAgentStopReason): void {
      setImmediate(() => {
        void run(numericMeetingId, stopReason);
      });
    }
  };
}
