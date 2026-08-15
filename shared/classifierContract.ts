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

// Únicamente "text" está habilitado en esta etapa (Día 1). Los otros valores
// del contrato quedan reservados para etapas futuras (Día 3-4 y sección 14).
export const SUPPORTED_SOURCE_TYPES: readonly SourceType[] = ["text"];

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
