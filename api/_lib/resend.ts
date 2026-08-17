import { Resend } from "resend";
import type { RiskLevel } from "../../shared/classifierContract.js";

export class ResendConfigError extends Error {}
export class ResendSendError extends Error {}

interface AlertEmailParams {
  to: string;
  contactName: string;
  riskLevel: RiskLevel;
  signals: string[];
  explanation: string;
  recommendedAction: string;
}

// Arma el cuerpo del email en texto plano (sin HTML): evita cualquier
// necesidad de escapar los valores dinámicos que vienen de Gemini/la base,
// y es más que suficiente para una alerta simple. No incluye raw_text
// completo — solo el resumen del riesgo (sección 3 de indicaciones.md),
// para reducir la exposición de datos del mensaje original.
function buildAlertEmailText(params: AlertEmailParams): string {
  const signalsBlock =
    params.signals.length > 0 ? params.signals.map((s) => `- ${s}`).join("\n") : "(sin señales específicas detectadas)";

  return [
    `Hola ${params.contactName},`,
    "",
    `Te llega este mensaje porque alguien que te agregó como contacto de confianza en "¿Es estafa?" analizó un mensaje sospechoso y el resultado fue RIESGO ${params.riskLevel.toUpperCase()}.`,
    "",
    "Señales detectadas:",
    signalsBlock,
    "",
    "¿Qué significa?",
    params.explanation,
    "",
    "Qué se recomienda hacer:",
    params.recommendedAction,
    "",
    "---",
    "Esta herramienta orienta, pero no garantiza un resultado con certeza absoluta. Ante la duda, verificá siempre por el canal oficial del organismo o entidad correspondiente.",
  ].join("\n");
}

export async function sendAlertEmail(params: AlertEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.error("Falta configurar RESEND_API_KEY / RESEND_FROM_EMAIL.");
    throw new ResendConfigError("El servidor no está configurado correctamente para enviar alertas.");
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: params.to,
    subject: `Alerta de posible estafa — riesgo ${params.riskLevel}`,
    text: buildAlertEmailText(params),
  });

  if (error) {
    // No propagamos error.message tal cual al cliente final (podría incluir
    // detalles internos de Resend) — solo lo logueamos server-side.
    console.error("Resend rechazó el envío:", error.name, error.message);
    throw new ResendSendError(error.message || "Resend rechazó el envío.");
  }
}
