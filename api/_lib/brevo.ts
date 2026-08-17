import { BrevoClient, BrevoError } from "@getbrevo/brevo";
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

export interface SendAlertEmailResult {
  messageId?: string;
  // true si Brevo respondió que esta idempotencyKey ya fue procesada dentro
  // del TTL (ver isDuplicateParameterError) — no se generó un email nuevo
  // en esta llamada, pero el envío original ya fue aceptado por Brevo.
  alreadyProcessed: boolean;
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

// Detecta específicamente el rechazo de idempotencia de Brevo: HTTP 400 con
// body.code === "duplicate_parameter". Confirmado empíricamente (no solo
// por documentación) llamando dos veces seguidas a sendTransacEmail con el
// mismo headers.idempotencyKey: la primera devuelve un messageId real, la
// segunda tira exactamente este error, y el panel de Brevo
// (getTransacEmailsList) confirma un único email real entregado, no dos. No
// se compara el texto de err.message (frágil, puede cambiar de idioma) —
// solo el código estructurado del body, con un type guard acotado.
function isDuplicateParameterError(err: unknown): boolean {
  if (!(err instanceof BrevoError)) return false;
  if (err.statusCode !== 400) return false;
  const body = err.body;
  if (typeof body !== "object" || body === null || !("code" in body)) return false;
  return (body as { code?: unknown }).code === "duplicate_parameter";
}

// idempotencyKey: se reutiliza el UUID de la fila de alerts_sent (ver
// api/send-alert.ts). Va como headers.idempotencyKey en el body de la
// request — NO es un header HTTP de la llamada a la API ni tampoco (pese a
// la documentación ambigua de Brevo, que describe el campo `headers` como
// "custom email headers") un header cosmético del email de salida: es un
// campo especial que la propia API de Brevo intercepta para deduplicar,
// con un TTL documentado de 30 minutos
// (https://developers.brevo.com/docs/heterogenous-versions-batch-emails).
// Reutilizar el mismo alertId en todos los reintentos de una misma alerta
// hace que, si Brevo ya proceso ese envío dentro de los últimos 30
// minutos, el reintento sea rechazado con `duplicate_parameter` en vez de
// generar un segundo email real — comportamiento verificado con envíos
// reales, no asumido de la documentación.
//
// Pasado el TTL de 30 minutos, un reintento con la misma clave ya NO está
// garantizado como duplicado por Brevo: si la fila sigue en `failed` (ver
// api/send-alert.ts) y se reintenta después de ese margen, esta función
// vuelve a llamar a sendTransacEmail con el mismo alertId y Brevo puede
// aceptarlo como un envío nuevo — es una decisión deliberada del MVP
// (política "al menos una vez": se prioriza poder reenviar una alerta
// importante tras una falla temporal, aceptando el riesgo excepcional de
// un email duplicado si la respuesta de Brevo fue ambigua). No hay
// garantía de "exactamente una vez" para este caso. Lo que SÍ sigue siendo
// cierto sin ventana de expiración es más acotado que "sin duplicados":
// `unique(check_id, contact_id)` en `alerts_sent` impide que exista más de
// una FILA para el mismo par análisis+contacto (nunca hay dos alertas
// "en paralelo" para la misma combinación), y las transiciones
// compare-and-set impiden que dos requests concurrentes ganen la misma
// transición de estado. Ninguna de las dos evita que una única fila,
// reintentada legítimamente después del TTL de Brevo, dispare un segundo
// email real. Ver "Política de reintentos y garantía de entrega" en
// README.md.
export async function sendAlertEmail(params: AlertEmailParams, idempotencyKey: string): Promise<SendAlertEmailResult> {
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
      headers: { idempotencyKey },
    });
    return { messageId: response.messageId, alreadyProcessed: false };
  } catch (err) {
    if (isDuplicateParameterError(err)) {
      console.log("Brevo confirmó que esta idempotencyKey ya fue procesada (duplicate_parameter). alertId:", idempotencyKey);
      return { alreadyProcessed: true };
    }
    // No propagamos el mensaje crudo de Brevo al cliente final (podría
    // incluir detalles internos) — solo lo logueamos server-side. Nunca
    // logueamos la API key ni el cuerpo completo de la request/response.
    const message = err instanceof Error ? err.message : String(err);
    console.error("Brevo rechazó el envío:", message);
    throw new EmailSendError(message || "Brevo rechazó el envío.");
  }
}
