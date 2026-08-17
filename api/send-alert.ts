import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth, respondToAuthError, createUserScopedClient, type AuthenticatedUser } from "./_lib/auth.js";
import { sendAlertEmail, ResendConfigError, ResendSendError } from "./_lib/resend.js";
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

// Envía una alerta por email a un contacto familiar para un análisis ya
// persistido (api/analyze.ts) con riesgo medio/alto. No recibe del cliente
// nada más que los dos ids: destinatario, nivel de riesgo, señales,
// explicación y acción recomendada se recuperan de Supabase con la sesión
// del usuario (RLS), nunca se confía en lo que mande el body para esos
// datos. No vuelve a llamar a Gemini — solo lee lo que ya se clasificó.
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

  const supabase = createUserScopedClient(user.accessToken);

  // RLS ya garantiza que solo se puede leer un check/contacto propio — si
  // el id pertenece a otro usuario, esto devuelve "sin filas", no un error,
  // así que no filtramos si existe para otra cuenta.
  const { data: check, error: checkError } = await supabase
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

  const { data: contact, error: contactError } = await supabase
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

  // Reclama (o crea) la fila de alerts_sent de forma atómica: el constraint
  // unique(check_id, contact_id) hace que, ante requests simultáneas, solo
  // una gane el INSERT — la otra recibe 23505 y cae al camino de abajo.
  const { data: claimed, error: insertError } = await supabase
    .from("alerts_sent")
    .insert({ user_id: user.id, check_id: checkId, contact_id: contactId, status: "pending" })
    .select("id")
    .single<{ id: string }>();

  let alertId: string;

  if (insertError) {
    if (insertError.code !== "23505") {
      console.error("Error al registrar el envío:", insertError.message);
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }

    const { data: existing, error: existingError } = await supabase
      .from("alerts_sent")
      .select("id, status")
      .eq("check_id", checkId)
      .eq("contact_id", contactId)
      .maybeSingle<{ id: string; status: string }>();

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

    // status === "failed": reintento seguro, reutilizando la misma fila.
    // Si no hay match de ownership, la función devuelve una fila con todos
    // los campos en null (no un valor JS null) — hay que chequear .id, no
    // la sola presencia del objeto.
    const { data: retried, error: retryError } = await supabase.rpc("set_alert_status", {
      p_alert_id: existing.id,
      p_status: "pending",
      p_error_message: null,
    });
    if (retryError || !retried?.id) {
      console.error("Error al reintentar el envío:", retryError?.message);
      res.status(500).json({ error: GENERIC_ERROR });
      return;
    }
    alertId = existing.id;
  } else {
    alertId = claimed.id;
  }

  try {
    await sendAlertEmail({
      to: contact.email,
      contactName: contact.nombre,
      riskLevel: check.risk_level,
      signals: Array.isArray(check.signals) ? (check.signals as string[]) : [],
      explanation: check.explanation,
      recommendedAction: check.recommended_action,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.rpc("set_alert_status", {
      p_alert_id: alertId,
      p_status: "failed",
      p_error_message: message.slice(0, 300),
    });

    if (err instanceof ResendConfigError) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (err instanceof ResendSendError) {
      res.status(502).json({ error: "No se pudo enviar el email en este momento. Probá de nuevo en unos minutos." });
      return;
    }
    console.error("Error inesperado al enviar la alerta:", message);
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  const { error: finalizeError } = await supabase.rpc("set_alert_status", {
    p_alert_id: alertId,
    p_status: "sent",
    p_error_message: null,
  });
  if (finalizeError) {
    // El email ya salió; si esto falla solo queda desalineado el estado en
    // la base (podría reintentarse manualmente más adelante), pero no tiene
    // sentido informarle un error al usuario por esto.
    console.error("El email se envió pero no se pudo marcar como 'sent':", finalizeError.message);
  }

  res.status(200).json({ status: "sent" });
}
