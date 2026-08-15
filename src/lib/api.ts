import type { ClassifierRequest, ClassifierResult } from "../../shared/classifierContract";

export class AnalyzeError extends Error {}

export async function analyzeText(rawText: string): Promise<ClassifierResult> {
  const payload: ClassifierRequest = { raw_text: rawText, source_type: "text" };

  let response: Response;
  try {
    response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        : "No se pudo analizar el texto. Probá de nuevo en unos segundos.";
    throw new AnalyzeError(message);
  }

  return data as ClassifierResult;
}
