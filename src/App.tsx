import { useEffect, useState } from "react";
import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabaseClient";
import { FamilyContactsProvider } from "./lib/FamilyContactsProvider";
import { AlertSendingContext } from "./lib/alertSendingContextDef";
import { AuthScreen } from "./components/AuthScreen";
import { Analyzer } from "./components/Analyzer";
import { FamilyContacts } from "./components/FamilyContacts";

function LoadingScreen() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-gray-50 text-gray-600 dark:bg-gray-950 dark:text-gray-400">
      <p role="status" aria-live="polite">
        Cargando...
      </p>
    </div>
  );
}

// Corrección 7B.1: recibe alertSending del ancestro común (App) en vez de
// leerlo por contexto — es el único consumidor que no vive dentro de
// FamilyContactsProvider, así que se lo pasa directo por prop. Mientras hay
// un envío real en vuelo, "Cerrar sesión" queda deshabilitado (y su handler
// se corta también por las dudas, por si algo lo dispara sin pasar por el
// botón deshabilitado).
function AccountBar({ email, alertSending }: { email: string; alertSending: boolean }) {
  async function handleSignOut() {
    if (alertSending) return;
    await supabase.auth.signOut();
    // Analyzer, FamilyContacts y FamilyContactsProvider se desmontan al
    // perder la sesión (App deja de renderizarlos), así que todo su estado
    // (texto, imagen, resultado, check_id, estado de alerta, lista de
    // contactos) se descarta con ellos — no queda nada de la sesión
    // anterior visible al volver a ingresar.
  }

  return (
    <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 pt-4 text-sm text-gray-500 sm:px-6 dark:text-gray-400">
      <span className="truncate">{email}</span>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={alertSending}
        className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        Cerrar sesión
      </button>
    </div>
  );
}

function App() {
  const { session, loading } = useAuth();
  // Coordinación acotada (corrección 7B.1, sección D): true exactamente
  // mientras FamilyAlert tiene una request real de envío en vuelo. Vive en
  // App —el ancestro común de Analyzer, FamilyContacts y AccountBar— y se
  // expone al subárbol vía contexto para no tener que perforar props a
  // través de Analyzer hasta FamilyAlert.
  const [alertSending, setAlertSending] = useState(false);

  // App no se desmonta al cerrar sesión (solo cambia qué renderiza), así
  // que alertSending no se resetea solo entre sesiones. El único camino
  // realista para llegar acá con alertSending todavía en true es que la
  // sesión se haya perdido externamente (token vencido) mientras un envío
  // seguía en vuelo — no un logout por UI, que ya está bloqueado mientras
  // alertSending es true. Igual se limpia acá por las dudas, para no
  // arrancar la sesión siguiente con los controles bloqueados sin motivo.
  useEffect(() => {
    if (!session) setAlertSending(false);
  }, [session]);

  if (loading) {
    return <LoadingScreen />;
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <AlertSendingContext.Provider value={{ alertSending, setAlertSending }}>
        <AccountBar email={session.user.email ?? ""} alertSending={alertSending} />
        <FamilyContactsProvider>
          <Analyzer />
          <FamilyContacts />
        </FamilyContactsProvider>
      </AlertSendingContext.Provider>
    </div>
  );
}

export default App;
