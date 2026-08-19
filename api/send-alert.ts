import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, respondToAuthError, createUserScopedClient, type AuthenticatedUser } from "./_lib/auth.js";
import { createAdminClient, AdminConfigError } from "./_lib/supabaseAdmin.js";
import { sendAlertEmail, assertEmailConfigured, EmailConfigError, EmailSendError } from "./_lib/brevo.js";
import { reserveEmailAttempt, secondsUntilNextUtcMidnight } from "./_lib/emailQuota.js";
import type { RiskLevel } from "../shared/classifierContract.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_ERROR = "No se pudo procesar la solicitud. Probá de nuevo en unos segundos.";

interface SendAlertRequestBody {
  check_id?: unknown;
  contact_id?: unknown;
}

interface CheckRow {
  id: string;
  risk_level: RiskLevel;
  signals: unknown;
  explanation: string;
  recommended_action: string;
}

interface ContactRow {
  id: string;
  nombre: string;
  email: string;
}

interface AlertRow {
  id: string;
  status: string;
}

// pending -> failed, condicional: solo transiciona si el estado sigue
// siendo exactamente "pending" en el momento del UPDATE. Se reutiliza en
// los tres puntos donde una alerta ya reclamada ("pending") puede
// necesitar volver a "failed" antes de llegar a Brevo (configuración
// faltante, cupo agotado, error de la RPC de cupo) y también tras un error
// real de Brevo — misma semántica compare-and-set que ya usaba
// api/send-alert.ts, ahora en un solo lugar. Devuelve si la transición
// realmente ocurrió (false si la fila ya no estaba en "pending" o si la
// consulta falló) — el caller decide qué responder según ese resultado.
async function markAlertFailed(admin: SupabaseClient, alertId: string, errorMessage: string): Promise<boolean> {
  const { data, error } = await admin
    .from("alerts_sent")
    .update({ status: "failed", error_message: errorMessage.slice(0, 300) })
    .eq("id", alertId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error("No se pudo marcar la alerta como 'failed':", error.message);
    return false;
  }
  if (!data) {
    console.error("La alerta ya no estaba en 'pending' al intentar marcarla 'failed' (id:", alertId, ")");
    return false;
  }
  return true;
}

// Envía una alerta por email a un contacto familiar para un análisis ya
// persistido (api/analyze.ts) con riesgo medio/alto. No recibe del cliente
// nada más que los dos ids: destinatario, nivel de riesgo, señales,
// explicación y acción recomendada se recuperan de Supabase con la sesión
// del usuario (RLS), nunca se confía en lo que mande el body para esos
// datos. No vuelve a llamar a Gemini — solo lee lo que ya se clasificó.
//
// Las lecturas de checks/family_contacts usan createUserScopedClient()
// (RLS = barrera de ownership). Las escrituras en alerts_sent usan el
// cliente admin (service role) porque esa tabla ya no tiene ninguna
// política de insert/update para el rol authenticated — es la única forma
// de que exista una fila "pending"/"sent"/"failed", y las transiciones son
// siempre compare-and-set (UPDATE ... WHERE status = '<esperado>') para
// que dos requests simultáneas no puedan ganar ambas la misma transición.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  let user: AuthenticatedUser;
  try {
    user = await requireAuth(req);
  } catch (err) {
    if (respondToAuthError(res, err)) return;
    throw err;
  }

  const body = req.body as SendAlertRequestBody | undefined;
  const checkId = typeof body?.check_id === "string" ? body.check_id.trim() : "";
  const contactId = typeof body?.contact_id === "string" ? body.contact_id.trim() : "";

  if (!UUID_PATTERN.test(checkId) || !UUID_PATTERN.test(contactId)) {
    res.status(400).json({ error: "check_id y contact_id tienen que ser identificadores válidos." });
    return;
  }

  const userScoped = createUserScopedClient(user.accessToken);

  // RLS ya garantiza que solo se puede leer un check/contacto propio — si
  // el id pertenece a otro usuario, esto devuelve "sin filas", no un error,
  // así que no filtramos si existe para otra cuenta (404 genérico).
  const { data: check, error: checkError } = await userScoped
    .from("checks")
    .select("id, risk_level, signals, explanation, recommended_action")
    .eq("id", checkId)
    .maybeSingle<CheckRow>();

  if (checkError) {
    console.error("Error al buscar el análisis:", checkError.message);
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }
  if (!check) {
    res.status(404).json({ error: "No se encontró el análisis indicado." });
    return;
  }

  const { data: contact, error: contactError } = await userScoped
    .from("family_contacts")
    .select("id, nombre, email")
    .eq("id", contactId)
    .maybeSingle<ContactRow>();

  if (contactError) {
    console.error("Error al buscar el contacto:", contactError.message);
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }
  if (!contact) {
    res.status(404).json({ error: "No se encontró el contacto indicado." });
    return;
  }

  if (check.risk_level === "bajo") {
    res.status(422).json({ error: "Este análisis tiene riesgo bajo; no corresponde enviar una alerta." });
    return;
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    if (err instanceof AdminConfigError) {
      res.status(500).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Reclama (o crea) la fila de alerts_sent con el cliente admin. El
  // constraint unique(check_id, contact_id) garantiza que, ante requests
  // simultáneas, solo una gane el INSERT — la otra recibe 23505.
  const { data: claimed, error: insertError } = await admin
    .from("alerts_sent")
    .insert({ user_id: user.id, check_id: checkId, contact_id: contactId, status: "pending" })
    .select("id, status")
    .single<AlertRow>();

  let alertId: string;

  if (insertError) {
    if (insertError.code !== "23505") {
      console.error("Error al registrar el envío:", insertError.message);
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }

    const { data: existing, error: existingError } = await admin
      .from("alerts_sent")
      .select("id, status")
      .eq("check_id", checkId)
      .eq("contact_id", contactId)
      .maybeSingle<AlertRow>();

    if (existingError || !existing) {
      console.error("Error al leer el envío existente:", existingError?.message);
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }

    if (existing.status === "sent") {
      res.status(409).json({ error: "Ya se envió una alerta a este contacto para este análisis." });
      return;
    }
    if (existing.status === "pending") {
      res.status(409).json({ error: "Ya hay un envío en curso para este contacto y este análisis." });
      return;
    }

    // status === "failed": reintento seguro vía compare-and-set. Solo
    // transiciona si el estado sigue siendo exactamente "failed" en el
    // momento del UPDATE — si otra request ya la reclamó (ganó la carrera
    // entre el SELECT de arriba y este UPDATE), esta consulta afecta 0
    // filas y respondemos 409 en vez de mandar un segundo email.
    const { data: retried, error: retryError } = await admin
      .from("alerts_sent")
      .update({ status: "pending", error_message: null })
      .eq("id", existing.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle<{ id: string }>();

    if (retryError) {
      console.error("Error al reintentar el envío:", retryError.message);
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }
    if (!retried) {
      // Alguien más ganó la transición failed -> pending justo antes.
      res.status(409).json({ error: "Ya hay un envío en curso para este contacto y este análisis." });
      return;
    }
    alertId = retried.id;
  } else {
    alertId = claimed.id;
  }

  // Verificación de configuración ANTES de reservar cupo: si Brevo no está
  // configurado, este intento no va a poder llegar a la API de todas
  // formas — no tiene sentido gastar una unidad de cupo real por algo que
  // ya sabemos que no va a intentarse.
  try {
    assertEmailConfigured();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markAlertFailed(admin, alertId, message);
    if (err instanceof EmailConfigError) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error("Error inesperado al verificar la configuración de email:", message);
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  // Reserva atómica de una unidad de cupo diario (5/usuario, 250 global,
  // por día UTC — supabase/migrations/20260818134424_email_daily_usage.sql,
  // verificada por scripts/eval-email-quota.mts). Un error de la RPC NUNCA
  // se interpreta como "cupo agotado": es un error interno (500), distinto
  // de un rechazo real por límite (429).
  let quota;
  try {
    quota = await reserveEmailAttempt(admin, user.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al reservar cupo de email:", message);
    const markedFailed = await markAlertFailed(admin, alertId, "quota:reservation_error");
    if (!markedFailed) {
      console.error("Además, no se pudo marcar la alerta como 'failed' tras el error de reserva de cupo (id:", alertId, ")");
    }
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  if (quota.status !== "reserved") {
    // Cupo agotado (individual o global): la alerta reclamada vuelve a
    // "failed" (no queda colgada en "pending"), sin haber llamado a Brevo
    // ni una vez y sin haber gastado ninguna unidad de cupo adicional. Un
    // reintento el mismo día UTC va a volver a pasar por acá y a recibir
    // el mismo 429; al empezar un día UTC nuevo, reserve_email_attempt
    // opera sobre un período distinto y el reintento puede prosperar.
    const isUserLimit = quota.status === "user_limit";
    const errorCode = isUserLimit ? "quota:user_daily_limit" : "quota:global_daily_limit";
    const clientMessage = isUserLimit
      ? "Alcanzaste el límite diario de alertas. Probá de nuevo mañana."
      : "El servicio alcanzó el límite diario de alertas. Probá de nuevo mañana.";

    const markedFailed = await markAlertFailed(admin, alertId, errorCode);
    if (!markedFailed) {
      // No simulamos un 429 "prolijo" sobre un estado que no pudimos
      // confirmar — la alerta quedó en una situación inesperada (no
      // debería pasar: nada más toca esta fila mientras sigue "pending"),
      // así que respondemos 500 en vez de un 429 potencialmente engañoso.
      console.error("No se pudo marcar 'failed' tras denegar cupo (id:", alertId, ") — respondiendo 500 en vez de 429.");
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }

    const retryAfterSeconds = secondsUntilNextUtcMidnight();
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: clientMessage });
    return;
  }

  try {
    // idempotencyKey = el UUID de la propia alerta: estable en todos los
    // reintentos de esta misma fila, namespaced por diseño (una alerta =
    // un check + un contacto, ya garantizado por el unique constraint).
    //
    // A partir de este punto la unidad de cupo reservada arriba queda
    // consumida sin importar qué pase después (éxito, duplicate_parameter,
    // error genuino, timeout o respuesta ambigua de Brevo) — no hay
    // "reembolso": intentar una transacción distribuida entre Postgres y
    // Brevo agregaría complejidad real para resolver un caso límite de bajo
    // impacto. La única ventana inevitable es que, si el proceso se cae
    // después de esta reserva pero antes de que la llamada a Brevo llegue a
    // completarse (éxito o error), la unidad queda consumida sin que se
    // haya mandado ningún email — documentado, no simulado como resuelto.
    const result = await sendAlertEmail(
      {
        to: contact.email,
        contactName: contact.nombre,
        riskLevel: check.risk_level,
        signals: Array.isArray(check.signals) ? (check.signals as string[]) : [],
        explanation: check.explanation,
        recommendedAction: check.recommended_action,
      },
      alertId,
    );
    // result.alreadyProcessed === true: Brevo respondió `duplicate_parameter`
    // (ver api/_lib/brevo.ts) — significa que un envío anterior con este
    // mismo alertId ya fue aceptado dentro de los últimos 30 minutos, no que
    // este intento falló. Se trata igual que un envío exitoso: se transiciona
    // a `sent` sin haber generado un email nuevo en esta llamada. Se loguea
    // el messageId (cuando lo hay) junto con el id de la alerta, para poder
    // reconciliar manualmente contra el dashboard de Brevo si hiciera falta.
    if (result.alreadyProcessed) {
      console.log("Brevo ya había procesado este envío (duplicate_parameter). alertId:", alertId);
    } else {
      console.log("Brevo aceptó el envío. alertId:", alertId, "messageId:", result.messageId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markAlertFailed(admin, alertId, message);

    if (err instanceof EmailConfigError) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (err instanceof EmailSendError) {
      res.status(502).json({ error: "No se pudo enviar el email en este momento. Probá de nuevo en unos minutos." });
      return;
    }
    console.error("Error inesperado al enviar la alerta:", message);
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  // pending -> sent, condicional. Si esto no afecta ninguna fila, el estado
  // quedó inconsistente con lo que esperábamos (no debería pasar dado que
  // solo esta request tenía la alerta en "pending") — no confirmamos
  // "sent" al cliente sin esa garantía.
  const { data: markedSent, error: markSentError } = await admin
    .from("alerts_sent")
    .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
    .eq("id", alertId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (markSentError || !markedSent) {
    console.error(
      "El email se envió pero no se pudo confirmar el estado 'sent' de forma consistente:",
      markSentError?.message ?? "(0 filas afectadas)",
    );
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  res.status(200).json({ status: "sent" });
}
