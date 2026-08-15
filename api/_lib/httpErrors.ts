import type { VercelResponse } from "@vercel/node";
import { GeminiError } from "./gemini.js";

const RATE_LIMIT_MESSAGE = "Se hicieron muchos análisis en poco tiempo. Esperá unos segundos y volvé a intentar.";
const DEFAULT_RETRY_AFTER_SECONDS = 20;

// Traduce un GeminiError a la respuesta HTTP correspondiente. Compartido por
// api/analyze.ts y api/extract-image.ts para no duplicar el manejo del 429
// del tier gratuito (RESOURCE_EXHAUSTED) en los dos endpoints.
export function respondToGeminiError(res: VercelResponse, err: GeminiError, fallbackMessage: string): void {
  if (err.status === 429) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS));
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return;
  }
  res.status(502).json({ error: fallbackMessage });
}
