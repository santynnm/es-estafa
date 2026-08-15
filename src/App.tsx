import { useState, type FormEvent } from "react";
import type { ClassifierResult } from "../shared/classifierContract";
import { analyzeText, AnalyzeError } from "./lib/api";
import { ResultCard } from "./components/ResultCard";

const MAX_LENGTH = 6000;

function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClassifierResult | null>(null);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !loading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const classification = await analyzeText(trimmed);
      setResult(classification);
    } catch (err) {
      setError(err instanceof AnalyzeError ? err.message : "Ocurrió un error inesperado. Probá de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-3xl font-bold sm:text-4xl">¿Es estafa?</h1>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
            Pegá un mensaje, SMS, email o la descripción de una llamada sospechosa y te ayudamos a
            entender qué tan riesgoso es.
          </p>
        </header>

        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <strong className="block font-semibold">Antes de continuar</strong>
          No pegues contraseñas, códigos de seguridad ni datos de tarjetas o cuentas bancarias reales.
        </div>

        <form onSubmit={handleSubmit} className="mt-6">
          <label htmlFor="raw_text" className="block text-lg font-semibold">
            Pegá el mensaje sospechoso
          </label>
          <textarea
            id="raw_text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_LENGTH}
            rows={8}
            placeholder='Ej: "Su tarjeta fue bloqueada. Ingrese ahora a este enlace y confirme su clave para reactivarla."'
            className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base leading-relaxed text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          <div className="mt-1 text-right text-sm text-gray-500 dark:text-gray-400">
            {text.length}/{MAX_LENGTH}
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-4 w-full rounded-xl bg-purple-600 px-6 py-4 text-xl font-bold text-white shadow-md transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
          >
            {loading ? "Analizando..." : "Analizar"}
          </button>
        </form>

        {loading && (
          <p
            role="status"
            aria-live="polite"
            className="mt-4 text-center text-base text-gray-600 dark:text-gray-400"
          >
            Estamos analizando el mensaje, esto puede tardar unos segundos...
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-base text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          >
            {error}
          </div>
        )}

        {result && <ResultCard result={result} />}

        <footer className="mt-10 border-t border-gray-200 pt-6 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          Esta herramienta orienta, pero no garantiza un resultado con certeza absoluta. Ante la duda,
          verificá siempre por el canal oficial del organismo o entidad (línea telefónica oficial, app o
          sitio web verificado).
        </footer>
      </main>
    </div>
  );
}

export default App;
