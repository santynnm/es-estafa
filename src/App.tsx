import { useRef, useState, type FormEvent } from "react";
import type { ClassifierResult } from "../shared/classifierContract";
import { analyzeRawText, extractTextFromImage, AnalyzeError, type ImageMimeType } from "./lib/api";
import { fileToBase64, FileReadError } from "./lib/imageFile";
import { ResultCard } from "./components/ResultCard";
import { ImageUpload } from "./components/ImageUpload";

const MAX_LENGTH = 6000;

type Mode = "text" | "image";
type Stage = "idle" | "reading" | "analyzing";

function App() {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageValidationError, setImageValidationError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClassifierResult | null>(null);

  // Guard síncrono contra doble clic/envío duplicado: `stage` es estado de
  // React (actualización asíncrona/batcheada), así que dos clicks casi
  // simultáneos pueden leer "idle" ambos antes del primer re-render. Un ref
  // se muta al instante, sin esperar el ciclo de render.
  const submittingRef = useRef(false);

  const trimmedText = text.trim();
  const canSubmit =
    stage === "idle" &&
    (mode === "text" ? trimmedText.length > 0 : imageFile !== null && !imageValidationError);

  function handleModeChange(nextMode: Mode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setError(null);
    setResult(null);
    setImageValidationError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;

    if (mode === "text") {
      if (!trimmedText) return;
      submittingRef.current = true;
      setError(null);
      setResult(null);
      setStage("analyzing");
      try {
        const classification = await analyzeRawText(trimmedText, "text");
        setResult(classification);
      } catch (err) {
        setError(err instanceof AnalyzeError ? err.message : "Ocurrió un error inesperado. Probá de nuevo.");
      } finally {
        submittingRef.current = false;
        setStage("idle");
      }
      return;
    }

    if (!imageFile || imageValidationError) return;
    submittingRef.current = true;
    setError(null);
    setResult(null);
    setStage("reading");
    try {
      const base64 = await fileToBase64(imageFile);
      const rawText = await extractTextFromImage(base64, imageFile.type as ImageMimeType);
      setStage("analyzing");
      const classification = await analyzeRawText(rawText, "image_ocr");
      setResult(classification);
    } catch (err) {
      setError(
        err instanceof AnalyzeError || err instanceof FileReadError
          ? err.message
          : "Ocurrió un error inesperado. Probá de nuevo.",
      );
    } finally {
      submittingRef.current = false;
      setStage("idle");
    }
  }

  const statusMessage =
    stage === "reading"
      ? "Leyendo la captura, esto puede tardar unos segundos..."
      : stage === "analyzing"
        ? "Analizando el mensaje, esto puede tardar unos segundos..."
        : null;

  const submitLabel =
    stage === "reading" ? "Leyendo la captura..." : stage === "analyzing" ? "Analizando..." : "Analizar";

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-3xl font-bold sm:text-4xl">¿Es estafa?</h1>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
            Pegá un mensaje sospechoso o subí una captura de pantalla y te ayudamos a entender qué tan
            riesgoso es.
          </p>
        </header>

        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <strong className="block font-semibold">Antes de continuar</strong>
          No pegues ni subas contraseñas, códigos de seguridad ni datos de tarjetas o cuentas bancarias
          reales.
        </div>

        <div role="group" aria-label="Elegir modo de análisis" className="mt-6 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handleModeChange("text")}
            aria-pressed={mode === "text"}
            className={`rounded-xl border-2 px-4 py-3 text-base font-semibold transition ${
              mode === "text"
                ? "border-purple-600 bg-purple-600 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            }`}
          >
            Pegar un texto
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("image")}
            aria-pressed={mode === "image"}
            className={`rounded-xl border-2 px-4 py-3 text-base font-semibold transition ${
              mode === "image"
                ? "border-purple-600 bg-purple-600 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            }`}
          >
            Subir una captura
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6">
          {mode === "text" ? (
            <>
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
            </>
          ) : (
            <ImageUpload
              file={imageFile}
              onFileChange={setImageFile}
              error={imageValidationError}
              onErrorChange={setImageValidationError}
              disabled={stage !== "idle"}
            />
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-4 w-full rounded-xl bg-purple-600 px-6 py-4 text-xl font-bold text-white shadow-md transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
          >
            {submitLabel}
          </button>
        </form>

        {statusMessage && (
          <p role="status" aria-live="polite" className="mt-4 text-center text-base text-gray-600 dark:text-gray-400">
            {statusMessage}
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
