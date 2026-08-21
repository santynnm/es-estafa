import { useEffect, useRef, useState, type FormEvent } from "react";
import { useFamilyContacts } from "../lib/useFamilyContacts";
import { useAlertSending } from "../lib/useAlertSending";
import { useNavigation } from "../lib/useNavigation";
import { ContactsError, MAX_NOMBRE_LENGTH, MAX_EMAIL_LENGTH } from "../lib/contacts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sección "Personas de confianza" (renombrada en la corrección previa al
// Día 9 — antes "Contactos familiares"; el modelo de datos, la tabla
// family_contacts y el nombre del componente no cambian, solo el texto
// visible). Desde el Día 7B lee y escribe sobre la misma lista compartida
// que usa FamilyAlert (FamilyContactsProvider) — un alta o baja acá se
// refleja de inmediato ahí y en el contador de MainNav, sin refetch.
//
// Corrección 7B.1: mientras hay un envío de alerta real en vuelo
// (alertSending, compartido con Analyzer/FamilyAlert/logout), el alta y la
// baja quedan bloqueadas — no tendría sentido borrar a la persona a la que
// se le está mandando un email en ese mismo instante.
export function FamilyContacts() {
  const { contacts, loading: listLoading, error: listError, addContact, removeContact } = useFamilyContacts();
  const { alertSending } = useAlertSending();
  const { contactsFocusRequestToken } = useNavigation();

  const [showForm, setShowForm] = useState(false);
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addedConfirmation, setAddedConfirmation] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const nombreInputRef = useRef<HTMLInputElement>(null);

  // Foco accesible al abrir el formulario (sin scroll animado: .focus() sin
  // opciones usa el desplazamiento nativo del navegador, que es instantáneo,
  // no la animación "smooth" que sí se usa deliberadamente en otros lados).
  useEffect(() => {
    if (showForm) nombreInputRef.current?.focus();
  }, [showForm]);

  // Foco movido desde otra sección (CTA de FamilyAlert cuando no hay
  // personas guardadas) — ver navigationContextDef.ts. 0 es el valor
  // inicial, nunca dispara foco por sí solo (ni al montar ni al volver a
  // esta sección por la pestaña, que ya deja el foco en la pestaña).
  useEffect(() => {
    if (contactsFocusRequestToken === 0) return;
    const heading = document.getElementById("family-contacts-heading");
    if (!heading) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  }, [contactsFocusRequestToken]);

  function openForm() {
    if (alertSending) return;
    setAddedConfirmation(null);
    setShowForm(true);
  }

  function cancelForm() {
    if (addLoading || alertSending) return;
    setShowForm(false);
    setAddError(null);
    setNombre("");
    setEmail("");
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (addLoading || alertSending) return;

    const trimmedNombre = nombre.trim();
    const trimmedEmail = email.trim();

    if (!trimmedNombre) {
      setAddError("Ingresá un nombre.");
      return;
    }
    if (trimmedNombre.length > MAX_NOMBRE_LENGTH) {
      setAddError(`El nombre es demasiado largo (máximo ${MAX_NOMBRE_LENGTH} caracteres).`);
      return;
    }
    if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
      setAddError("El email no tiene un formato válido.");
      return;
    }
    if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
      setAddError(`El email es demasiado largo (máximo ${MAX_EMAIL_LENGTH} caracteres).`);
      return;
    }
    if (contacts?.some((c) => c.email.toLowerCase() === trimmedEmail.toLowerCase())) {
      setAddError("Ya tenés una persona guardada con ese email.");
      return;
    }

    setAddLoading(true);
    setAddError(null);
    try {
      await addContact(trimmedNombre, trimmedEmail);
      setNombre("");
      setEmail("");
      setShowForm(false);
      setAddedConfirmation(`Agregaste a ${trimmedNombre} a tu lista de personas de confianza.`);
    } catch (err) {
      setAddError(err instanceof ContactsError ? err.message : "No se pudo agregar a la persona.");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId || alertSending) return;
    setDeletingId(id);
    setDeleteError(null);
    try {
      await removeContact(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof ContactsError ? err.message : "No se pudo eliminar a la persona.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section id="family-contacts" className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h2
        id="family-contacts-heading"
        tabIndex={-1}
        className="text-2xl font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 rounded"
      >
        Personas de confianza
      </h2>
      <p className="mt-2 text-base text-gray-700 dark:text-gray-300">
        Agregá a una persona de confianza para poder avisarle por email si un análisis muestra riesgo
        medio o alto. Nunca enviaremos nada sin que vos lo confirmes.
      </p>
      <p className="mt-2 text-base text-gray-700 dark:text-gray-300">
        Recibirá un resumen del nivel de riesgo, las señales detectadas y qué hacer. No enviaremos el
        mensaje o la captura original.
      </p>

      {listLoading && (
        <p role="status" aria-live="polite" className="mt-4 text-base text-gray-600 dark:text-gray-400">
          Cargando personas de confianza...
        </p>
      )}

      {listError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {listError}
        </div>
      )}

      {!listLoading && !listError && contacts && contacts.length === 0 && (
        <p className="mt-4 rounded-xl border-2 border-dashed border-gray-300 p-4 text-base text-gray-600 dark:border-gray-700 dark:text-gray-400">
          Todavía no agregaste a nadie. Podés hacerlo ahora para tener a quién avisar si detectamos algo
          riesgoso.
        </p>
      )}

      {!listLoading && contacts && contacts.length > 0 && (
        <ul className="mt-4 space-y-2">
          {contacts.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-3 rounded-xl border-2 border-gray-300 bg-white p-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:bg-gray-900"
            >
              <div className="min-w-0">
                <p className="break-words font-semibold">{c.nombre}</p>
                <p className="break-all text-sm text-gray-600 dark:text-gray-400">{c.email}</p>
              </div>

              {confirmDeleteId === c.id ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <span role="status" className="sr-only">
                    Confirmá si querés eliminar a {c.nombre}.
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(c.id)}
                    disabled={deletingId === c.id || alertSending}
                    aria-disabled={deletingId === c.id || alertSending}
                    className="inline-flex min-h-11 items-center rounded-lg bg-red-600 px-3 font-medium text-white transition hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {deletingId === c.id ? "Eliminando..." : "Sí, eliminar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    disabled={deletingId === c.id || alertSending}
                    aria-disabled={deletingId === c.id || alertSending}
                    className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-3 font-medium text-gray-700 transition hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(c.id)}
                  disabled={alertSending}
                  aria-disabled={alertSending}
                  className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-gray-300 px-3 font-medium text-gray-700 transition hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Eliminar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {deleteError}
        </div>
      )}

      {addedConfirmation && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-xl border-2 border-green-300 bg-green-50 p-4 text-base text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
        >
          {addedConfirmation}
        </div>
      )}

      {!showForm ? (
        <button
          type="button"
          onClick={openForm}
          disabled={alertSending}
          aria-disabled={alertSending}
          className="mt-6 min-h-11 w-full rounded-xl bg-purple-600 px-6 py-4 text-xl font-bold text-white shadow-md transition hover:bg-purple-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
        >
          Agregar una persona
        </button>
      ) : (
        <form onSubmit={handleAdd} noValidate className="mt-6 space-y-4">
          <div>
            <label htmlFor="contact-nombre" className="block text-base font-semibold">
              Nombre
            </label>
            <input
              id="contact-nombre"
              ref={nombreInputRef}
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={MAX_NOMBRE_LENGTH}
              disabled={addLoading || alertSending}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div>
            <label htmlFor="contact-email" className="block text-base font-semibold">
              Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={MAX_EMAIL_LENGTH}
              disabled={addLoading || alertSending}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={addLoading || alertSending}
              aria-disabled={addLoading || alertSending}
              className="min-h-11 flex-1 rounded-xl bg-purple-600 px-6 py-4 text-lg font-bold text-white shadow-md transition hover:bg-purple-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
            >
              {addLoading ? "Agregando..." : "Guardar persona"}
            </button>
            <button
              type="button"
              onClick={cancelForm}
              disabled={addLoading || alertSending}
              aria-disabled={addLoading || alertSending}
              className="min-h-11 rounded-xl border border-gray-300 px-6 py-4 text-lg font-medium text-gray-700 transition hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {addError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {addError}
        </div>
      )}
    </section>
  );
}
