import { buildPrompt } from "./prompt.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 20_000;

export class GeminiError extends Error {}
export class InvalidGeminiResponseError extends Error {}

// Devuelve el texto crudo generado por Gemini para raw_text. La validación
// contra el contrato del clasificador (sección 8) se hace en api/analyze.ts,
// no acá, para mantener esta función enfocada solo en hablar con Gemini.
export async function callGemini(rawText: string, apiKey: string): Promise<string> {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(rawText) }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (err) {
    throw new GeminiError(
      err instanceof Error && err.name === "AbortError"
        ? "Gemini no respondió a tiempo."
        : `No se pudo contactar a Gemini: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GeminiError(`Gemini respondió con error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new InvalidGeminiResponseError("Gemini no devolvió contenido.");
  }
  return text;
}
