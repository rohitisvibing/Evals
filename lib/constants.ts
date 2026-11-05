// Shared, non-secret constants (safe to import from scripts, tests and server code).

export const versions = {
  decisionSchema: "decision.v1",
  gradeSchema: "answer-grade.v1",
  rubric: "judge-rubric.v1",
  answerRubric: "judge-answer-rubric.v1",
  jevPrompt: "jev-questions.v1",
  jevAnswerPrompt: "jev-answer-questions.v1",
  generatorPrompt: "rag-answer.v1",
  qaDataset: "qa.v1",
  chunker: "chunk.v1",
  dataset: "golden.v1",
} as const;

export const limits = {
  monthlyQuestions: 10,
  maxPdfBytes: 20 * 1024 * 1024,
  maxPages: 300,
  maxClaimChars: 1000,
  maxQuestionChars: 500,
  maxDocumentsPerUser: 10,
  defaultK: 8,
  maxK: 12,
  providerTimeoutMs: 30_000,
  providerMaxRetries: 2,
  perUserPerMinute: 5,
  perIpPerMinute: 20,
  uploadsPerUserPerHour: 10,
} as const;

export type ProviderModels = { jev: string; judge: string; embedding: string; answer: string };

export function providerModels(): ProviderModels {
  return {
    jev: process.env.JEV_MODEL?.trim() || "jev-1.14.0",
    judge: process.env.JUDGE_MODEL?.trim() || "google/gemma-4-31b-it:free",
    embedding: process.env.EMBEDDING_MODEL?.trim() || "baai/bge-m3",
    answer: process.env.ANSWER_MODEL?.trim() || "openai/gpt-4.1-nano",
  };
}

export const EMBEDDING_DIM = 1024;
