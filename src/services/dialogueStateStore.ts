export type DialoguePhase = "greeting" | "questions" | "closing";

export type DialogueInterviewContext = {
  candidateFirstName?: string;
  candidateLastName?: string;
  companyName?: string;
  jobTitle?: string;
  vacancyText?: string;
  specialtyName?: string;
  greetingSpeech?: string;
  finalSpeech?: string;
  questions?: Array<{ text: string; order: number }>;
  mainPrompt?: string;
  idkAnswers?: string[];
};

export type DialogueStateRecord = {
  meetingId: string;
  sessionId: string;
  phase: DialoguePhase;
  questionIndex: number;
  lastResponseId?: string;
  dialogueContext: DialogueInterviewContext;
  updatedAtMs: number;
};

export class DialogueStateStore {
  private readonly records = new Map<string, DialogueStateRecord>();

  get(meetingId: string): DialogueStateRecord | undefined {
    return this.records.get(meetingId);
  }

  upsert(input: {
    meetingId: string;
    sessionId: string;
    dialogueContext?: DialogueInterviewContext;
    phase?: DialoguePhase;
    questionIndex?: number;
  }): DialogueStateRecord {
    const existing = this.records.get(input.meetingId);
    const record: DialogueStateRecord = {
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      phase: input.phase ?? existing?.phase ?? "greeting",
      questionIndex: input.questionIndex ?? existing?.questionIndex ?? 0,
      lastResponseId: existing?.lastResponseId,
      dialogueContext: input.dialogueContext ?? existing?.dialogueContext ?? {},
      updatedAtMs: Date.now()
    };
    this.records.set(input.meetingId, record);
    return record;
  }

  patch(meetingId: string, patch: Partial<Pick<DialogueStateRecord, "phase" | "questionIndex" | "lastResponseId">>): void {
    const record = this.records.get(meetingId);
    if (!record) {
      return;
    }
    if (patch.phase !== undefined) {
      record.phase = patch.phase;
    }
    if (patch.questionIndex !== undefined) {
      record.questionIndex = patch.questionIndex;
    }
    if (patch.lastResponseId !== undefined) {
      record.lastResponseId = patch.lastResponseId;
    }
    record.updatedAtMs = Date.now();
  }

  delete(meetingId: string): void {
    this.records.delete(meetingId);
  }
}

export const dialogueStateStore = new DialogueStateStore();
