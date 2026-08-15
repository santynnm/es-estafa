import { buildPrompt } from "./prompt.js";

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 20_000;

// Esquema enviado a Gemini para pedir salida JSON estructurada (mejora la
// consistencia del modelo). Es un detalle interno de esta llamada, no el
// contrato público — ese sigue siendo shared/classifierContract.ts, validado
// igual en api/analyze.ts sin confiar ciegamente en que Gemini lo respete.
const CLASSIFIER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    risk_level: { type: "STRING", enum: ["bajo", "medio", "alto"] },
    signals: { type: "ARRAY", items: { type: "STRING" } },
    explanation: { type: "STRING" },
    recommended_action: { type: "STRING" },
  },
  required: ["risk_level", "signals", "explanation", "recommended_action"],
  propertyOrdering: ["risk_level", "signals", "explanation", "recommended_action"],
};

// Preserva el status HTTP devuelto por Gemini (en particular 429, límite del
// tier gratuito) para que api/analyze.ts y api/extract-image.ts puedan
// propagarlo al cliente en vez de convertir todo en un 502 genérico.
export class GeminiError extends Error {
  status?: number;
  retryAfterSeconds?: number;

  constructor(message: string, options?: { status?: number; retryAfterSeconds?: number }) {
    super(message);
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}
export class InvalidGeminiResponseError extends Error {}

interface GenerateContentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GenerateContentParams {
  model?: string;
  parts: GenerateContentPart[];
  generationConfig: Record<string, unknown>;
}

// Best-effort: Gemini puede indicar cuánto esperar vía el header Retry-After
// o, en el body de error de un 429, vía google.rpc.RetryInfo.retryDelay
// (ej: "20s"). Si no hay ninguno, devuelve undefined y el caller usa un
// default razonable.
function parseRetryAfterSeconds(response: Response, bodyText: string): number | undefined {
  const header = response.headers.get("retry-after");
  if (header && !Number.isNaN(Number(header))) {
    return Number(header);
  }
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { details?: Array<{ ["@type"]?: string; retryDelay?: string }> };
    };
    const retryInfo = parsed.error?.details?.find((d) => d["@type"]?.includes("RetryInfo"));
    const match = retryInfo?.retryDelay ? /^(\d+(?:\.\d+)?)s$/.exec(retryInfo.retryDelay) : null;
    if (match) return Math.ceil(Number(match[1]));
  } catch {
    // best-effort, ignorar si el body no es el JSON esperado.
  }
  return undefined;
}

// Llamada de bajo nivel a generateContent, compartida por la clasificación de
// texto (callGemini) y la extracción visual (api/_lib/vision.ts). No sabe
// nada de clasificar riesgo ni de OCR — solo habla con la API de Gemini y
// devuelve el texto crudo de la primera respuesta.
async function generateContent(params: GenerateContentParams, apiKey: string): Promise<string> {
  const model = params.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
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
        contents: [{ parts: params.parts }],
        generationConfig: params.generationConfig,
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
    throw new GeminiError(`Gemini respondió con error ${response.status}: ${body.slice(0, 500)}`, {
      status: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(response, body),
    });
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

// Devuelve el texto crudo generado por Gemini para raw_text. La validación
// contra el contrato del clasificador (sección 8) se hace en api/analyze.ts,
// no acá, para mantener esta función enfocada solo en hablar con Gemini.
export async function callGemini(rawText: string, apiKey: string): Promise<string> {
  return generateContent(
    {
      parts: [{ text: buildPrompt(rawText) }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: CLASSIFIER_RESPONSE_SCHEMA,
      },
    },
    apiKey,
  );
}

export { generateContent };
export type { GenerateContentPart };
