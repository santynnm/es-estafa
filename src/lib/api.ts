import type { ClassifierRequest, ClassifierResult } from "../../shared/classifierContract";
import { supabase } from "./supabaseClient";

export class AnalyzeError extends Error {}

// El clasificador soporta "text" | "image_ocr" | "audio_transcript" en el
// contrato compartido, pero el frontend en esta etapa solo puede originar
// los dos primeros — audio sigue sin implementarse.
export type FrontendSourceType = Extract<ClassifierRequest["source_type"], "text" | "image_ocr">;

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

// Cuerpo de /api/extract-image. Es un tipo interno de este endpoint, separado
// a propósito del contrato público del clasificador (sección 8).
interface ExtractImageRequest {
  image_base64: string;
  mime_type: ImageMimeType;
}

interface ExtractImageResponse {
  raw_text: string;
}

// POST genérico con el manejo de errores compartido entre analyzeRawText y
// extractTextFromImage, para no duplicarlo entre el modo texto y el modo imagen.
// Incluye siempre el access token actual de la sesión: se pide con
// getSession() en cada llamada (Supabase lo renueva solo en segundo plano),
// nunca se guarda en una variable propia que podría vencerse.
async function postJson<TResponse>(url: string, payload: unknown): Promise<TResponse> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new AnalyzeError("Se cerró tu sesión. Volvé a ingresar para continuar.");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AnalyzeError("No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AnalyzeError("El servidor devolvió una respuesta inesperada. Probá de nuevo.");
  }

  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : "No se pudo completar la operación. Probá de nuevo en unos segundos.";
    throw new AnalyzeError(message);
  }

  return data as TResponse;
}

// Clasifica raw_text (venga de un textarea o de una imagen ya transcripta).
export async function analyzeRawText(rawText: string, sourceType: FrontendSourceType): Promise<ClassifierResult> {
  const payload: ClassifierRequest = { raw_text: rawText, source_type: sourceType };
  return postJson<ClassifierResult>("/api/analyze", payload);
}

// Extrae el texto visible de una captura de pantalla. No clasifica riesgo —
// el resultado se pasa después a analyzeRawText con source_type: "image_ocr".
export async function extractTextFromImage(imageBase64: string, mimeType: ImageMimeType): Promise<string> {
  const payload: ExtractImageRequest = { image_base64: imageBase64, mime_type: mimeType };
  const { raw_text } = await postJson<ExtractImageResponse>("/api/extract-image", payload);
  return raw_text;
}
