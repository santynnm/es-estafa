import { BrevoClient } from "@getbrevo/brevo";
import type { RiskLevel } from "../../shared/classifierContract.js";

export class EmailConfigError extends Error {}
export class EmailSendError extends Error {}

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

// idempotencyKey: se reutiliza el UUID de la fila de alerts_sent (ver
// api/send-alert.ts) también acá, pero a diferencia de Resend, el endpoint
// de envío individual de Brevo (transactionalEmails.sendTransacEmail) NO
// ofrece una clave de idempotencia real a nivel de API — el tipo instalado
// (SendTransacEmailRequest.headers) solo documenta "Idempotency-Key" como
// ejemplo de header MIME de salida (cosmético, lo ve el destinatario, no
// deduplica nada del lado de Brevo). La única deduplicación mecánica que
// existe en el SDK es para el envío por lotes (messageVersions), que no es
// el que usamos acá (un destinatario por llamada). Por eso: (a) igual se
// manda el header, sin costo y sin efecto dañino, por si algún día Brevo lo
// empieza a usar; (b) la protección real contra duplicados sigue siendo
// exclusivamente el compare-and-set en Postgres (api/send-alert.ts); (c) se
// guarda el messageId que devuelve Brevo en error_message/logs para poder
// reconciliar manualmente contra el dashboard de Brevo si hiciera falta.
export async function sendAlertEmail(params: AlertEmailParams, idempotencyKey: string): Promise<string | undefined> {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME;
  if (!apiKey || !senderEmail || !senderName) {
    console.error("Falta configurar BREVO_API_KEY / BREVO_SENDER_EMAIL / BREVO_SENDER_NAME.");
    throw new EmailConfigError("El servidor no está configurado correctamente para enviar alertas.");
  }

  const client = new BrevoClient({ apiKey });

  try {
    const response = await client.transactionalEmails.sendTransacEmail({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: params.to, name: params.contactName }],
      subject: `Alerta de posible estafa — riesgo ${params.riskLevel}`,
      textContent: buildAlertEmailText(params),
      headers: { "Idempotency-Key": idempotencyKey },
    });
    return response.messageId;
  } catch (err) {
    // No propagamos el mensaje crudo de Brevo al cliente final (podría
    // incluir detalles internos) — solo lo logueamos server-side. Nunca
    // logueamos la API key ni el cuerpo completo de la request/response.
    const message = err instanceof Error ? err.message : String(err);
    console.error("Brevo rechazó el envío:", message);
    throw new EmailSendError(message || "Brevo rechazó el envío.");
  }
}
