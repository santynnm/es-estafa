import { useState, type FormEvent } from "react";
import { supabase, isSupabaseConfigured } from "../lib/supabaseClient";
import { translateAuthError } from "../lib/authErrors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6; // mínimo por defecto de Supabase Auth.

type Mode = "login" | "signup";

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function handleModeChange(nextMode: Mode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setError(null);
    setInfo(null);
    setConfirmPassword("");
  }

  function validate(): string | null {
    if (!email.trim()) return "Ingresá tu email.";
    if (!EMAIL_PATTERN.test(email.trim())) return "El email no tiene un formato válido.";
    if (!password) return "Ingresá tu contraseña.";
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `La contraseña tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    }
    if (mode === "signup" && password !== confirmPassword) {
      return "Las contraseñas no coinciden.";
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setInfo(null);
      return;
    }

    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) {
          setError(translateAuthError(signInError.message));
        }
        // Si no hay error, onAuthStateChange actualiza la sesión y AuthGate
        // muestra la app automáticamente.
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (signUpError) {
          setError(translateAuthError(signUpError.message));
        } else if (!data.session) {
          // Sin sesión inmediata: Supabase exige confirmar el email (o, por
          // seguridad, responde igual aunque el email ya exista, sin revelar
          // cuál es el caso).
          setInfo("Te enviamos un email para confirmar tu cuenta. Revisá tu correo y volvé a ingresar.");
        }
        // Si data.session existe, onAuthStateChange ya deja al usuario adentro.
      }
    } catch {
      setError("No se pudo conectar con el servidor. Revisá tu conexión e intentá de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main className="mx-auto max-w-md px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-3xl font-bold sm:text-4xl">¿Es estafa?</h1>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
            Ingresá o creá una cuenta para analizar mensajes y capturas sospechosas.
          </p>
        </header>

        {!isSupabaseConfigured && (
          <div
            role="alert"
            className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          >
            Falta configurar Supabase en este entorno (variables <code>VITE_SUPABASE_URL</code> y{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>). El login no va a funcionar hasta que se carguen.
          </div>
        )}

        <div role="group" aria-label="Elegir entre ingresar o crear cuenta" className="mt-6 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handleModeChange("login")}
            aria-pressed={mode === "login"}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border-2 px-4 py-3 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 ${
              mode === "login"
                ? "border-purple-600 bg-purple-600 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            }`}
          >
            {mode === "login" && (
              <span aria-hidden="true">✓</span>
            )}
            Ingresar
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("signup")}
            aria-pressed={mode === "signup"}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border-2 px-4 py-3 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 ${
              mode === "signup"
                ? "border-purple-600 bg-purple-600 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            }`}
          >
            {mode === "signup" && (
              <span aria-hidden="true">✓</span>
            )}
            Crear cuenta
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-base font-semibold">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-base font-semibold">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              aria-describedby={mode === "signup" ? "password-hint" : undefined}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
            {mode === "signup" && (
              <p id="password-hint" className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                Al menos {MIN_PASSWORD_LENGTH} caracteres.
              </p>
            )}
          </div>

          {mode === "signup" && (
            <div>
              <label htmlFor="confirmPassword" className="block text-base font-semibold">
                Confirmar contraseña
              </label>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            aria-disabled={loading}
            className="min-h-11 w-full rounded-xl bg-purple-600 px-6 py-4 text-xl font-bold text-white shadow-md transition hover:bg-purple-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
          >
            {loading ? "Un momento..." : mode === "login" ? "Ingresar" : "Crear cuenta"}
          </button>
        </form>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          >
            {error}
          </div>
        )}

        {info && (
          <div
            role="status"
            aria-live="polite"
            className="mt-4 rounded-xl border-2 border-green-300 bg-green-50 p-4 text-base text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
          >
            {info}
          </div>
        )}

        <footer className="mt-10 border-t border-gray-200 pt-6 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          Esta herramienta orienta, pero no garantiza un resultado con certeza absoluta. Ante la duda,
          verificá siempre por el canal oficial del organismo o entidad.
        </footer>
      </main>
    </div>
  );
}
