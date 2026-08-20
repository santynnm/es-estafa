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

// Resultado interno de analyzeRawText: el body HTTP de /api/analyze sigue
// siendo exactamente ClassifierResult (contrato compartido, sección 8) — el
// check_id NUNCA viaja adentro de ese body, solo en el header X-Check-ID
// (api/analyze.ts). Este tipo combina ambos del lado del cliente, para que
// Día 7B pueda usar el id sin tocar el contrato ni el backend.
export interface AnalyzeOutcome {
  result: ClassifierResult;
  checkId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractErrorMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data && typeof (data as { error: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return "No se pudo completar la operación. Probá de nuevo en unos segundos.";
}

// POST genérico de bajo nivel: agrega el access token actual (pedido con
// getSession() en cada llamada, nunca cacheado a mano) y devuelve tanto el
// body parseado como el Response crudo, para que cada caller pueda leer
// headers propios (X-Check-ID, Retry-After) sin duplicar el fetch.
//
// Acepta un AbortSignal opcional (corrección 7B.1): Analyzer lo usa para
// cortar de verdad un análisis/OCR en curso cuando el usuario invalida esa
// request (edita el input, cambia de modo/imagen, dispara un análisis
// nuevo). Un abort deliberado se relanza tal cual (DOMException
// "AbortError"), sin envolverlo en AnalyzeError — así el caller puede
// distinguirlo de un error de red real y no mostrar ningún mensaje.
async function postJsonRaw(url: string, payload: unknown, signal?: AbortSignal): Promise<{ data: unknown; response: Response }> {
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
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new AnalyzeError("No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AnalyzeError("El servidor devolvió una respuesta inesperada. Probá de nuevo.");
  }

  return { data, response };
}

async function postJson<TResponse>(url: string, payload: unknown, signal?: AbortSignal): Promise<TResponse> {
  const { data, response } = await postJsonRaw(url, payload, signal);
  if (!response.ok) {
    throw new AnalyzeError(extractErrorMessage(data));
  }
  return data as TResponse;
}

// Clasifica raw_text (venga de un textarea o de una imagen ya transcripta).
// Devuelve el resultado del clasificador junto con el check_id persistido
// por el backend (leído del header X-Check-ID, validado como UUID). Si el
// header falta o no es un UUID válido, no se muestra el resultado como
// disponible para alertar: se lanza un error controlado y no se reintenta
// el análisis solo — ya se gastó la llamada real a Gemini, reintentar
// automáticamente la duplicaría sin necesidad.
//
// El signal opcional no cambia el contrato HTTP ni el body enviado — solo
// permite abortar la request desde el caller (ver Analyzer.tsx).
export async function analyzeRawText(
  rawText: string,
  sourceType: FrontendSourceType,
  signal?: AbortSignal,
): Promise<AnalyzeOutcome> {
  const payload: ClassifierRequest = { raw_text: rawText, source_type: sourceType };
  const { data, response } = await postJsonRaw("/api/analyze", payload, signal);

  if (!response.ok) {
    throw new AnalyzeError(extractErrorMessage(data));
  }

  const checkId = response.headers.get("X-Check-ID");
  if (!checkId || !UUID_PATTERN.test(checkId)) {
    throw new AnalyzeError(
      "El análisis se completó pero no se pudo confirmar su identificador. Probá de nuevo en unos segundos.",
    );
  }

  return { result: data as ClassifierResult, checkId };
}

// Extrae el texto visible de una captura de pantalla. No clasifica riesgo —
// el resultado se pasa después a analyzeRawText con source_type: "image_ocr".
export async function extractTextFromImage(imageBase64: string, mimeType: ImageMimeType, signal?: AbortSignal): Promise<string> {
  const payload: ExtractImageRequest = { image_base64: imageBase64, mime_type: mimeType };
  const { raw_text } = await postJson<ExtractImageResponse>("/api/extract-image", payload, signal);
  return raw_text;
}

// Error de /api/send-alert (Día 7B). Conserva el status HTTP y, cuando el
// backend lo manda (429 por cupo agotado), el Retry-After ya parseado a
// segundos — nunca se usa para un countdown ni un reintento automático, solo
// queda disponible por si la UI quiere mostrarlo como dato informativo.
export class AlertSendError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Envía una alerta por email a un contacto familiar para un análisis ya
// clasificado. Manda ÚNICAMENTE check_id y contact_id — el backend
// (api/send-alert.ts) recupera destinatario, nivel de riesgo, señales,
// explicación y acción recomendada de Supabase con la sesión del usuario;
// este cliente nunca envía esos datos ni raw_text ni contenido de imagen.
export async function sendFamilyAlert(checkId: string, contactId: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new AlertSendError("Se cerró tu sesión. Volvé a ingresar para continuar.", 401);
  }

  let response: Response;
  try {
    response = await fetch("/api/send-alert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ check_id: checkId, contact_id: contactId }),
    });
  } catch {
    throw new AlertSendError("No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.", 0);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AlertSendError("El servidor devolvió una respuesta inesperada. Probá de nuevo.", response.status);
  }

  if (!response.ok) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds =
      retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
    throw new AlertSendError(extractErrorMessage(data), response.status, retryAfterSeconds);
  }

  const isValidSuccess = typeof data === "object" && data !== null && (data as { status?: unknown }).status === "sent";
  if (!isValidSuccess) {
    throw new AlertSendError("El servidor devolvió una respuesta inesperada. Probá de nuevo.", response.status);
  }
}
