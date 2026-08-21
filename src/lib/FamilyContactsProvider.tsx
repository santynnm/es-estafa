import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./useAuth";
import { listContacts, addContact as addContactApi, deleteContact as deleteContactApi, ContactsError, type FamilyContact } from "./contacts";
import { FamilyContactsContext } from "./familyContactsContextDef";

// Fuente única de contactos familiares para toda la vista autenticada (Día
// 7B, sección B): antes FamilyContacts tenía su propio estado local; ahora
// tanto FamilyContacts como FamilyAlert leen y escriben la misma lista, así
// un alta/baja se refleja de inmediato en los dos lugares sin refetch y sin
// riesgo de que queden desincronizados.
export function FamilyContactsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? "";

  const [contacts, setContacts] = useState<FamilyContact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listContacts()
      .then((data) => {
        if (!cancelled) setContacts(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ContactsError ? err.message : "No se pudieron cargar las personas de confianza.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const addContact = useCallback(
    async (nombre: string, email: string) => {
      const created = await addContactApi(userId, nombre, email);
      setContacts((prev) => [...(prev ?? []), created]);
      return created;
    },
    [userId],
  );

  const removeContact = useCallback(async (id: string) => {
    await deleteContactApi(id);
    setContacts((prev) => (prev ?? []).filter((c) => c.id !== id));
  }, []);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return (
    <FamilyContactsContext.Provider value={{ contacts, loading, error, addContact, removeContact, reload }}>
      {children}
    </FamilyContactsContext.Provider>
  );
}
