import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { buildDialogueInstructions } from "./dialoguePromptBuilder";
import type { DialogueInterviewContext } from "./dialogueStateStore";

export type GenerateDialogueReplyOptions = {
  candidateText: string;
  dialogueContext?: DialogueInterviewContext;
  previousResponseId?: string;
  model?: string;
  signal?: AbortSignal;
};

function extractResponsesOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const output = body.output;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (row.type === "message" && Array.isArray(row.content)) {
      for (const block of row.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "output_text" && typeof b.text === "string" && b.text.trim()) {
          parts.push(b.text.trim());
        }
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * OpenAI Responses API — LLM leg of staged voice pipeline.
 * @see https://developers.openai.com/api/docs/guides/responses
 */
export async function generateDialogueReply(
  options: GenerateDialogueReplyOptions
): Promise<{ replyText: string; responseId?: string; durationMs: number }> {
  const startedAt = Date.now();
  const input = options.candidateText.trim();
  if (!input) {
    return { replyText: "", durationMs: Date.now() - startedAt };
  }

  const model = options.model ?? env.OPENAI_LLM_MODEL;
  const instructions = buildDialogueInstructions(options.dialogueContext);
  const url = `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/responses`;

  const body: Record<string, unknown> = {
    model,
    instructions,
    input
  };
  if (options.previousResponseId) {
    body.previous_response_id = options.previousResponseId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_HTTP_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      logger.warn(
        {
          event: "openai_responses_dialogue_failed",
          status: response.status,
          model,
          bodyPreview: errBody.slice(0, 300)
        },
        "openai responses dialogue failed"
      );
      throw new HttpError(502, `openai_responses_http_${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const replyText = extractResponsesOutputText(payload);
    const responseId = typeof payload.id === "string" ? payload.id : undefined;
    const durationMs = Date.now() - startedAt;

    if (!replyText) {
      throw new HttpError(502, "openai_responses_empty_output");
    }

    logger.info(
      {
        event: "openai_responses_dialogue_ok",
        model,
        llmMs: durationMs,
        replyChars: replyText.length,
        responseId
      },
      "openai responses dialogue ok"
    );

    return { replyText, responseId, durationMs };
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(499, "openai_responses_aborted");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `openai_responses_error: ${message}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
