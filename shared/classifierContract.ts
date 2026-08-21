// Contrato del clasificador de IA — sección 8 de indicaciones.md.
// Estable: no modificar esta interfaz. Reutilizada por frontend y backend
// para que Día 3-4 (image_ocr) y Día 8 (audio_transcript) entren por el
// mismo contrato sin tocar el núcleo del clasificador.

export type SourceType = "text" | "image_ocr" | "audio_transcript";

export interface ClassifierRequest {
  raw_text: string;
  source_type: SourceType;
}

export type RiskLevel = "bajo" | "medio" | "alto";

export interface ClassifierResult {
  risk_level: RiskLevel;
  signals: string[];
  explanation: string;
  recommended_action: string;
}

export const RISK_LEVELS: readonly RiskLevel[] = ["bajo", "medio", "alto"];

// Los tres source_type que /api/analyze acepta en runtime. "text" (Día 1) e
// "image_ocr" (Día 3-4A) se originan hoy desde el frontend (ver
// FrontendSourceType en src/lib/api.ts). "audio_transcript" (Día 8A) no tiene
// todavía ningún origen real — no hay grabación, transcripción ni botón de
// audio implementados (sección 14) — pero el endpoint ya lo acepta como
// pathway compatible: cuando exista un adaptador que transcriba audio a
// texto, podrá llamar al mismo /api/analyze sin que este archivo ni el
// endpoint necesiten otro cambio.
export const SUPPORTED_SOURCE_TYPES: readonly SourceType[] = ["text", "image_ocr", "audio_transcript"];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as string[]).includes(value);
}

export function isClassifierResult(value: unknown): value is ClassifierResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isRiskLevel(v.risk_level) &&
    Array.isArray(v.signals) &&
    v.signals.every((s) => typeof s === "string" && s.trim().length > 0) &&
    typeof v.explanation === "string" &&
    v.explanation.trim().length > 0 &&
    typeof v.recommended_action === "string" &&
    v.recommended_action.trim().length > 0
  );
}
