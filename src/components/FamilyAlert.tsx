import { useEffect, useRef, useState } from "react";
import type { RiskLevel } from "../../shared/classifierContract";
import { sendFamilyAlert, AlertSendError } from "../lib/api";
import { useFamilyContacts } from "../lib/useFamilyContacts";
import { useAlertSending } from "../lib/useAlertSending";

type SendOutcome =
  | { kind: "sent"; contactName: string }
  | { kind: "already_sent" }
  | { kind: "in_progress" }
  | { kind: "error"; message: string };

function focusFamilyContacts() {
  const heading = document.getElementById("family-contacts-heading");
  if (!heading) return;
  heading.scrollIntoView({ behavior: "smooth", block: "start" });
  heading.focus();
}

// Flujo visible "Avisarle a un familiar" (Día 7B). Vive junto al resultado
// de un análisis con riesgo medio/alto — el padre (Analyzer) es responsable
// de solo montarlo cuando existen result + checkId válidos y el riesgo no es
// "bajo"; acá se repite ese último chequeo como defensa en profundidad, sin
// depender únicamente del padre.
//
// Nunca manda al backend nada más que check_id + contact_id (sendFamilyAlert,
// src/lib/api.ts) — el resto (destinatario, señales, explicación, etc.) lo
// resuelve /api/send-alert del lado del servidor.
//
// Corrección 7B.1: usa el booleano compartido `alertSending` (en vez de un
// estado "sending" propio) para que Analyzer, FamilyContacts y el logout
// puedan coordinarse mientras un envío real está en vuelo.
export function FamilyAlert({ checkId, riskLevel }: { checkId: string; riskLevel: RiskLevel }) {
  const { contacts, loading, error: contactsError, reload } = useFamilyContacts();
  const { alertSending, setAlertSending } = useAlertSending();

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);

  // Guard síncrono contra doble clic: `alertSending` es estado de React (no
  // aplica al instante), así que dos clicks casi simultáneos podrían leer
  // "false" los dos antes del primer re-render.
  const sendingRef = useRef(false);

  const selectedContact = contacts?.find((c) => c.id === selectedContactId) ?? null;

  // Si el contacto seleccionado se elimina desde FamilyContacts (misma
  // fuente compartida), la selección y cualquier confirmación pendiente se
  // limpian solas. No puede pasar mientras alertSending es true (la baja de
  // contactos está bloqueada en ese momento), pero queda igual como
  // salvaguarda genérica.
  useEffect(() => {
    if (selectedContactId && contacts && !contacts.some((c) => c.id === selectedContactId)) {
      setSelectedContactId(null);
    }
  }, [contacts, selectedContactId]);

  if (riskLevel === "bajo") return null;

  function openSelector() {
    if (alertSending) return;
    setSelectorOpen(true);
    setSelectedContactId(null);
    setOutcome(null);
  }

  function cancel() {
    if (alertSending) return;
    setSelectorOpen(false);
    setSelectedContactId(null);
  }

  async function confirmSend() {
    if (sendingRef.current || !selectedContact) return;
    // Captura nombre/id ANTES de que arranque el envío: el mensaje de éxito
    // no puede depender de que `contacts` siga teniendo esta fila más
    // adelante (aunque, con alertSending en true, la baja de contactos ya
    // está bloqueada — esto es además una garantía por diseño, no solo
    // consecuencia de ese bloqueo).
    const contactIdToSend = selectedContact.id;
    const contactNameToSend = selectedContact.nombre;

    sendingRef.current = true;
    setAlertSending(true);
    setOutcome(null);
    try {
      await sendFamilyAlert(checkId, contactIdToSend);
      setOutcome({ kind: "sent", contactName: contactNameToSend });
    } catch (err) {
      if (err instanceof AlertSendError) {
        if (err.status === 409 && /ya se envió/i.test(err.message)) {
          setOutcome({ kind: "already_sent" });
        } else if (err.status === 409) {
          setOutcome({ kind: "in_progress" });
        } else {
          setOutcome({ kind: "error", message: err.message });
        }
      } else {
        setOutcome({ kind: "error", message: "Ocurrió un error inesperado. Probá de nuevo." });
      }
    } finally {
      sendingRef.current = false;
      setAlertSending(false);
    }
  }

  // Ya se confirmó un envío exitoso (o ya estaba enviado de antes): no se
  // vuelve a ofrecer el flujo para este mismo resultado. El nombre viene del
  // outcome capturado al confirmar, nunca de un lookup en vivo sobre
  // `contacts` — así un cambio posterior en la lista (en otra pestaña, por
  // ejemplo) no puede alterar retroactivamente este mensaje.
  if (outcome?.kind === "sent" || outcome?.kind === "already_sent") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-4 rounded-xl border-2 border-green-300 bg-green-50 p-4 text-base text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
      >
        {outcome.kind === "sent"
          ? `Alerta enviada a ${outcome.contactName}.`
          : "Ya se había enviado una alerta a este contacto para este análisis."}
      </div>
    );
  }

  if (loading) {
    return (
      <p role="status" aria-live="polite" className="mt-4 text-base text-gray-600 dark:text-gray-400">
        Cargando contactos...
      </p>
    );
  }

  if (contactsError) {
    return (
      <div
        role="alert"
        className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      >
        <p>No se pudo cargar tu lista de contactos, así que no podemos ofrecerte avisarle a nadie todavía.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reload()}
            className="rounded-lg border border-red-400 px-3 py-1.5 font-medium text-red-900 hover:bg-red-100 dark:border-red-600 dark:text-red-100 dark:hover:bg-red-900"
          >
            Reintentar
          </button>
          <button
            type="button"
            onClick={focusFamilyContacts}
            className="rounded-lg border border-red-400 px-3 py-1.5 font-medium text-red-900 hover:bg-red-100 dark:border-red-600 dark:text-red-100 dark:hover:bg-red-900"
          >
            Ir a contactos
          </button>
        </div>
      </div>
    );
  }

  const hasContacts = (contacts?.length ?? 0) > 0;

  if (!hasContacts) {
    return (
      <div className="mt-4 rounded-xl border-2 border-dashed border-gray-300 p-4 text-base text-gray-700 dark:border-gray-700 dark:text-gray-300">
        <p>Primero agregá al menos un contacto familiar.</p>
        <button
          type="button"
          onClick={focusFamilyContacts}
          className="mt-3 rounded-lg bg-purple-600 px-4 py-2 font-semibold text-white hover:bg-purple-700"
        >
          Agregar un contacto
        </button>
      </div>
    );
  }

  if (!selectorOpen) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={openSelector}
          disabled={alertSending}
          className="w-full rounded-xl border-2 border-purple-600 bg-white px-6 py-4 text-lg font-bold text-purple-700 shadow-sm transition hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-900 dark:text-purple-300 dark:hover:bg-gray-800"
        >
          Avisarle a un familiar
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border-2 border-purple-300 bg-purple-50 p-4 dark:border-purple-700 dark:bg-purple-950">
      <label htmlFor="family-alert-contact" className="block text-base font-semibold text-gray-900 dark:text-gray-100">
        Elegí un contacto
      </label>
      <select
        id="family-alert-contact"
        value={selectedContactId ?? ""}
        disabled={alertSending}
        onChange={(e) => setSelectedContactId(e.target.value || null)}
        className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-3 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <option value="" disabled>
          Seleccioná un contacto...
        </option>
        {contacts!.map((c) => (
          <option key={c.id} value={c.id}>
            {c.nombre} ({c.email})
          </option>
        ))}
      </select>

      {selectedContact && (
        <div className="mt-4">
          <p className="break-words text-base text-gray-900 dark:text-gray-100">
            Se enviará una alerta a <strong>{selectedContact.nombre}</strong> ({selectedContact.email}).
          </p>

          {outcome?.kind === "in_progress" && (
            <p role="status" aria-live="polite" className="mt-2 text-base text-amber-800 dark:text-amber-300">
              Ya hay un envío en curso para este contacto. Esperá un momento y volvé a intentar.
            </p>
          )}
          {outcome?.kind === "error" && (
            <div
              role="alert"
              className="mt-2 rounded-lg border-2 border-red-300 bg-red-50 p-3 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
            >
              {outcome.message}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmSend}
              disabled={alertSending}
              className="rounded-xl bg-purple-600 px-5 py-3 text-base font-bold text-white shadow-md transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
            >
              {alertSending ? "Enviando alerta..." : "Confirmar envío"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={alertSending}
              className="rounded-xl border border-gray-300 px-5 py-3 text-base font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancelar
            </button>
          </div>

          {alertSending && (
            <p role="status" aria-live="polite" className="sr-only">
              Enviando alerta...
            </p>
          )}
        </div>
      )}
    </div>
  );
}
