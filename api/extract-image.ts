import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractTextFromImage } from "./_lib/vision.js";
import { GeminiError, InvalidGeminiResponseError } from "./_lib/gemini.js";
import { respondToGeminiError } from "./_lib/httpErrors.js";

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_DECODED_BYTES = 3 * 1024 * 1024; // 3 MB — margen respecto del límite de body de Vercel.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

interface ExtractImageRequestBody {
  image_base64?: unknown;
  mime_type?: unknown;
}

// Extrae texto de una captura de pantalla. No clasifica riesgo: solo hace
// imagen -> raw_text. El frontend (o quien llame a este endpoint) es
// responsable de mandar ese raw_text a /api/analyze con source_type:
// "image_ocr" para obtener el veredicto, reutilizando el mismo clasificador
// calibrado en el Día 2. La imagen nunca se persiste — se procesa en memoria
// para esta única request y se descarta.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Falta la variable de entorno GEMINI_API_KEY.");
    res.status(500).json({ error: "El servidor no está configurado correctamente. Intentá más tarde." });
    return;
  }

  const body = req.body as ExtractImageRequestBody | undefined;
  const imageBase64 = typeof body?.image_base64 === "string" ? body.image_base64.replace(/\s/g, "") : "";
  const mimeType = typeof body?.mime_type === "string" ? body.mime_type : "";

  if (!imageBase64) {
    res.status(400).json({ error: "image_base64 es requerido y no puede estar vacío." });
    return;
  }
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    res.status(400).json({ error: `mime_type debe ser uno de: ${ALLOWED_MIME_TYPES.join(", ")}.` });
    return;
  }
  if (!BASE64_PATTERN.test(imageBase64) || imageBase64.length % 4 !== 0) {
    res.status(400).json({ error: "image_base64 no es un base64 válido." });
    return;
  }

  const decoded = Buffer.from(imageBase64, "base64");
  if (decoded.length === 0) {
    res.status(400).json({ error: "image_base64 no se pudo decodificar." });
    return;
  }
  if (decoded.length > MAX_DECODED_BYTES) {
    res.status(400).json({
      error: `La imagen supera el tamaño máximo permitido (${Math.floor(MAX_DECODED_BYTES / (1024 * 1024))} MB).`,
    });
    return;
  }

  try {
    const rawText = (await extractTextFromImage(imageBase64, mimeType, apiKey)).trim();

    if (!rawText) {
      res.status(422).json({
        error: "No se detectó texto legible en la imagen. Probá subir una captura más clara o con más contraste.",
      });
      return;
    }

    res.status(200).json({ raw_text: rawText });
  } catch (err) {
    if (err instanceof InvalidGeminiResponseError) {
      console.error("Respuesta inválida de Gemini (visión):", err.message);
      res.status(502).json({ error: "No pudimos leer el contenido de la imagen. Probá de nuevo en unos segundos." });
      return;
    }
    if (err instanceof GeminiError) {
      console.error("Error al llamar a Gemini (visión):", err.message);
      respondToGeminiError(res, err, "No se pudo procesar la imagen en este momento. Probá de nuevo en unos segundos.");
      return;
    }
    console.error("Error inesperado en /api/extract-image:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado. Probá de nuevo en unos segundos." });
  }
}
