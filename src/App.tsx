import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabaseClient";
import { FamilyContactsProvider } from "./lib/FamilyContactsProvider";
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

function AccountBar({ email }: { email: string }) {
  async function handleSignOut() {
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
        className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        Cerrar sesión
      </button>
    </div>
  );
}

function App() {
  const { session, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <AccountBar email={session.user.email ?? ""} />
      <FamilyContactsProvider>
        <Analyzer />
        <FamilyContacts />
      </FamilyContactsProvider>
    </div>
  );
}

export default App;
