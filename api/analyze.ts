import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  type ClassifierRequest,
  type ClassifierResult,
  isClassifierResult,
  SUPPORTED_SOURCE_TYPES,
} from "../shared/classifierContract.js";
import { callGemini, GeminiError, InvalidGeminiResponseError } from "./_lib/gemini.js";
import { respondToGeminiError } from "./_lib/httpErrors.js";
import { requireAuth, respondToAuthError } from "./_lib/auth.js";

const MAX_RAW_TEXT_LENGTH = 6000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  try {
    await requireAuth(req);
  } catch (err) {
    if (respondToAuthError(res, err)) return;
    throw err;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Falta la variable de entorno GEMINI_API_KEY.");
    res.status(500).json({ error: "El servidor no está configurado correctamente. Intentá más tarde." });
    return;
  }

  const body = req.body as Partial<ClassifierRequest> | undefined;
  const raw_text = typeof body?.raw_text === "string" ? body.raw_text.trim() : "";
  const source_type = body?.source_type;

  if (!raw_text) {
    res.status(400).json({ error: "El texto a analizar no puede estar vacío." });
    return;
  }
  if (raw_text.length > MAX_RAW_TEXT_LENGTH) {
    res.status(400).json({ error: `El texto es demasiado largo (máximo ${MAX_RAW_TEXT_LENGTH} caracteres).` });
    return;
  }
  if (typeof source_type !== "string" || !(SUPPORTED_SOURCE_TYPES as readonly string[]).includes(source_type)) {
    res.status(400).json({ error: 'source_type debe ser "text" o "image_ocr" en esta etapa.' });
    return;
  }

  try {
    const rawResponse = await callGemini(raw_text, apiKey);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      throw new InvalidGeminiResponseError("Gemini no devolvió un JSON válido.");
    }

    if (!isClassifierResult(parsed)) {
      throw new InvalidGeminiResponseError("La respuesta de Gemini no respeta el contrato esperado.");
    }

    const result: ClassifierResult = {
      risk_level: parsed.risk_level,
      signals: parsed.signals,
      explanation: parsed.explanation,
      recommended_action: parsed.recommended_action,
    };

    res.status(200).json(result);
  } catch (err) {
    if (err instanceof InvalidGeminiResponseError) {
      console.error("Respuesta inválida de Gemini:", err.message);
      res.status(502).json({ error: "No pudimos interpretar el análisis. Probá de nuevo en unos segundos." });
      return;
    }
    if (err instanceof GeminiError) {
      console.error("Error al llamar a Gemini:", err.message);
      respondToGeminiError(res, err, "No se pudo analizar el texto en este momento. Probá de nuevo en unos segundos.");
      return;
    }
    console.error("Error inesperado en /api/analyze:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado. Probá de nuevo en unos segundos." });
  }
}
