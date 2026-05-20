import type { DialogueInterviewContext } from "./dialogueStateStore";

const VACANCY_CONTEXT_MAX_CHARS = 12_000;

function truncateVacancy(text: string | undefined, maxChars = VACANCY_CONTEXT_MAX_CHARS): string {
  const raw = (text ?? "").trim();
  if (!raw || raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, maxChars)}\n\n[…текст вакансии обрезан для лимита контекста; опирайся только на видимый фрагмент.]`;
}

export function getCandidateDisplayName(context?: DialogueInterviewContext): string {
  const full = [context?.candidateFirstName?.trim(), context?.candidateLastName?.trim()]
    .filter(Boolean)
    .join(" ")
    .trim();
  return full || "кандидат";
}

function resolvePlaceholders(text: string, context?: DialogueInterviewContext): string {
  const name = getCandidateDisplayName(context);
  const company = context?.companyName?.trim() ?? "";
  const jobTitle = context?.jobTitle?.trim() ?? "";
  let out = text;
  const repl: Array<[RegExp, string]> = [
    [/<Имя\s+Отчество>/gi, name],
    [/<Имя>/gi, name],
    [/\{\{\s*candidateFullName\s*\}\}/gi, name],
    [/\{candidateFullName\}/g, name]
  ];
  if (jobTitle) {
    repl.push([/\{\{\s*jobTitle\s*\}\}/gi, jobTitle], [/<Должность>/gi, jobTitle]);
  }
  if (company) {
    repl.push([/\{\{\s*companyName\s*\}\}/gi, company], [/<Компания>/gi, company]);
  }
  for (const [re, val] of repl) {
    out = out.replace(re, val);
  }
  return out;
}

/**
 * System instructions for staged Responses API dialogue (HR interviewer).
 */
export function buildDialogueInstructions(context?: DialogueInterviewContext): string {
  const candidateFullName = getCandidateDisplayName(context);
  const company = context?.companyName?.trim() || "компания не указана";
  const jobTitle = context?.jobTitle?.trim() || "должность не указана";
  const vacancyForModel = truncateVacancy(context?.vacancyText);
  const customGreeting = context?.greetingSpeech?.trim();
  const greeting = customGreeting
    ? resolvePlaceholders(customGreeting, context)
    : `Здравствуйте, ${candidateFullName}. Это интервью на позицию ${jobTitle} в компанию ${company}. Вы готовы пройти интервью?`;
  const finalSpeech = resolvePlaceholders(context?.finalSpeech?.trim() || "Спасибо за интервью.", context);
  const sortedQs = (context?.questions ?? []).slice().sort((a, b) => a.order - b.order);
  const questions = sortedQs.map((q, idx) => `${idx + 1}. [order=${q.order}] ${q.text}`).join("\n");
  const idkBlock =
    (context?.idkAnswers ?? []).length > 0
      ? (context?.idkAnswers ?? []).map((a, i) => `${i + 1}. ${a}`).join("\n")
      : "";

  const mainPrompt = context?.mainPrompt?.trim();
  if (mainPrompt) {
    return [
      "# Runtime mainPrompt",
      mainPrompt,
      "",
      `Кандидат: ${candidateFullName}`,
      `Компания: ${company}`,
      `Должность: ${jobTitle}`,
      questions ? `Вопросы:\n${questions}` : "",
      idkBlock ? `IDK-ответы:\n${idkBlock}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "Ты HR-интервьюер. Отвечай кратко, устно, на русском. Не раскрывай внутренние метки и JSON.",
    "Фазы: intro → questions (по order) → closing. Не выдумывай факты вне контекста ниже.",
    "",
    `Кандидат: ${candidateFullName}`,
    `Компания: ${company}`,
    `Должность: ${jobTitle}`,
    context?.specialtyName ? `Специальность: ${context.specialtyName}` : "",
    vacancyForModel ? `Описание вакансии:\n${vacancyForModel}` : "Описание вакансии: не передано.",
    "",
    `Приветствие (JobAI):\n${greeting}`,
    `Финал:\n${finalSpeech}`,
    questions ? `Вопросы (строгий порядок order):\n${questions}` : "Вопросы: список пуст — не выдумывай свои.",
    idkBlock ? `Если нет данных в материалах:\n${idkBlock}` : "",
    "",
    "На каждую реплику кандидата: одна связная ответная реплика интервьюера; не озвучивай [STATE:…]."
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildOpeningUtteranceForAgentSpeak(context?: DialogueInterviewContext): string {
  const company = context?.companyName?.trim();
  const selfIntro = company ? `Я HR аватар компании ${company}.` : "Я HR аватар, провожу это собеседование.";
  const customGreeting = context?.greetingSpeech?.trim();
  if (customGreeting) {
    return `${selfIntro} ${resolvePlaceholders(customGreeting, context)}`;
  }
  const name = getCandidateDisplayName(context);
  const jobTitle = context?.jobTitle?.trim() || "должность";
  const comp = context?.companyName?.trim() || "компанию";
  return `${selfIntro} Здравствуйте, ${name}. Это интервью на позицию ${jobTitle} в ${comp}. Вы готовы пройти интервью?`;
}
