import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../lib/useAuth";
import {
  listContacts,
  addContact,
  deleteContact,
  ContactsError,
  MAX_NOMBRE_LENGTH,
  MAX_EMAIL_LENGTH,
  type FamilyContact,
} from "../lib/contacts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function FamilyContacts() {
  const { session } = useAuth();
  const userId = session?.user.id ?? "";

  const [contacts, setContacts] = useState<FamilyContact[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    listContacts()
      .then((data) => {
        if (!cancelled) setContacts(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(err instanceof ContactsError ? err.message : "No se pudieron cargar los contactos.");
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (addLoading) return;

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
      setAddError("Ya tenés un contacto guardado con ese email.");
      return;
    }

    setAddLoading(true);
    setAddError(null);
    try {
      const created = await addContact(userId, trimmedNombre, trimmedEmail);
      setContacts((prev) => [...(prev ?? []), created]);
      setNombre("");
      setEmail("");
    } catch (err) {
      setAddError(err instanceof ContactsError ? err.message : "No se pudo agregar el contacto.");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteContact(id);
      setContacts((prev) => (prev ?? []).filter((c) => c.id !== id));
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof ContactsError ? err.message : "No se pudo eliminar el contacto.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="mx-auto max-w-2xl px-4 pb-8 sm:px-6">
      <h2 className="text-2xl font-bold">Contactos familiares</h2>
      <p className="mt-1 text-base text-gray-600 dark:text-gray-400">
        Guardá el email de alguien de confianza. Más adelante vas a poder avisarle si un análisis da riesgo
        medio o alto.
      </p>

      {listLoading && (
        <p role="status" aria-live="polite" className="mt-4 text-base text-gray-600 dark:text-gray-400">
          Cargando contactos...
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
          Todavía no cargaste ningún contacto. Agregá el primero acá abajo.
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
                <p className="truncate text-sm text-gray-600 dark:text-gray-400">{c.email}</p>
              </div>

              {confirmDeleteId === c.id ? (
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => handleDelete(c.id)}
                    disabled={deletingId === c.id}
                    className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {deletingId === c.id ? "Eliminando..." : "Sí, eliminar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    disabled={deletingId === c.id}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(c.id)}
                  className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
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

      <form onSubmit={handleAdd} noValidate className="mt-6 space-y-4">
        <div>
          <label htmlFor="contact-nombre" className="block text-base font-semibold">
            Nombre
          </label>
          <input
            id="contact-nombre"
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            maxLength={MAX_NOMBRE_LENGTH}
            disabled={addLoading}
            className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
            disabled={addLoading}
            className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>

        <button
          type="submit"
          disabled={addLoading}
          className="w-full rounded-xl bg-purple-600 px-6 py-4 text-xl font-bold text-white shadow-md transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
        >
          {addLoading ? "Agregando..." : "Agregar contacto"}
        </button>
      </form>

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
