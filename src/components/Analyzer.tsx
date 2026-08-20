import { useRef, useState, type FormEvent } from "react";
import type { ClassifierResult } from "../../shared/classifierContract";
import { analyzeRawText, extractTextFromImage, AnalyzeError, type ImageMimeType } from "../lib/api";
import { fileToBase64, FileReadError } from "../lib/imageFile";
import { ResultCard } from "./ResultCard";
import { ImageUpload } from "./ImageUpload";
import { FamilyAlert } from "./FamilyAlert";

const MAX_LENGTH = 6000;

type Mode = "text" | "image";
type Stage = "idle" | "reading" | "analyzing";

// Analizador de texto/imagen. Desde el Día 7B guarda también el check_id que
// devuelve /api/analyze (header X-Check-ID, ver src/lib/api.ts) junto con el
// resultado, para poder ofrecer "Avisarle a un familiar" (FamilyAlert) sin
// que el backend tenga que confiar en nada que mande el cliente aparte de
// esos dos ids ya persistidos.
export function Analyzer() {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageValidationError, setImageValidationError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClassifierResult | null>(null);
  const [checkId, setCheckId] = useState<string | null>(null);

  // Guard síncrono contra doble clic/envío duplicado: `stage` es estado de
  // React (actualización asíncrona/batcheada), así que dos clicks casi
  // simultáneos pueden leer "idle" ambos antes del primer re-render. Un ref
  // se muta al instante, sin esperar el ciclo de render.
  const submittingRef = useRef(false);

  // Sube en cada análisis iniciado; una respuesta que llega tarde (de un
  // análisis anterior, si el input cambió o se disparó uno nuevo mientras la
  // primera request seguía en vuelo) se descarta comparando contra el valor
  // vigente al momento de aplicar el resultado, en vez de pisar el estado
  // actual con datos obsoletos.
  const requestIdRef = useRef(0);

  const trimmedText = text.trim();
  const canSubmit =
    stage === "idle" &&
    (mode === "text" ? trimmedText.length > 0 : imageFile !== null && !imageValidationError);

  // Limpia resultado, check_id y (al desmontar FamilyAlert) cualquier estado
  // de alerta en curso — se llama cada vez que el análisis vigente deja de
  // corresponder al que se ve en pantalla: cambio de modo, edición del
  // texto tras un resultado, selección/cambio/remoción de imagen, o el
  // arranque de un análisis nuevo. Nunca se llama mientras una alerta se
  // está confirmando o enviando (eso vive en FamilyAlert, que se desmonta
  // junto con este estado, pero solo como consecuencia de que el usuario ya
  // decidió cambiar de análisis, no de manera espontánea).
  function clearResult() {
    setResult(null);
    setCheckId(null);
  }

  function handleModeChange(nextMode: Mode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setError(null);
    clearResult();
    setImageValidationError(null);
  }

  function handleTextChange(value: string) {
    setText(value);
    if (result) {
      clearResult();
      setError(null);
    }
  }

  // Centraliza el cambio de archivo (selección, cambio o "Quitar" -> null):
  // el veredicto y el error general corresponden al archivo anterior, así
  // que nunca deben seguir visibles una vez que ese archivo ya no es el
  // seleccionado. `imageValidationError` se mantiene aparte porque lo
  // administra ImageUpload para el archivo nuevo.
  function handleImageFileChange(file: File | null) {
    setImageFile(file);
    clearResult();
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;

    const requestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== requestId;

    if (mode === "text") {
      if (!trimmedText) return;
      submittingRef.current = true;
      setError(null);
      clearResult();
      setStage("analyzing");
      try {
        const outcome = await analyzeRawText(trimmedText, "text");
        if (!isStale()) {
          setResult(outcome.result);
          setCheckId(outcome.checkId);
        }
      } catch (err) {
        if (!isStale()) {
          setError(err instanceof AnalyzeError ? err.message : "Ocurrió un error inesperado. Probá de nuevo.");
        }
      } finally {
        submittingRef.current = false;
        if (!isStale()) setStage("idle");
      }
      return;
    }

    if (!imageFile || imageValidationError) return;
    submittingRef.current = true;
    setError(null);
    clearResult();
    setStage("reading");
    try {
      const base64 = await fileToBase64(imageFile);
      const rawText = await extractTextFromImage(base64, imageFile.type as ImageMimeType);
      if (isStale()) return;
      setStage("analyzing");
      const outcome = await analyzeRawText(rawText, "image_ocr");
      if (!isStale()) {
        setResult(outcome.result);
        setCheckId(outcome.checkId);
      }
    } catch (err) {
      if (!isStale()) {
        setError(
          err instanceof AnalyzeError || err instanceof FileReadError
            ? err.message
            : "Ocurrió un error inesperado. Probá de nuevo.",
        );
      }
    } finally {
      submittingRef.current = false;
      if (!isStale()) setStage("idle");
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
              onChange={(e) => handleTextChange(e.target.value)}
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
            onFileChange={handleImageFileChange}
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

      {result && (
        <>
          <ResultCard result={result} />
          {checkId && result.risk_level !== "bajo" && <FamilyAlert checkId={checkId} riskLevel={result.risk_level} />}
        </>
      )}

      <footer className="mt-10 border-t border-gray-200 pt-6 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Esta herramienta orienta, pero no garantiza un resultado con certeza absoluta. Ante la duda,
        verificá siempre por el canal oficial del organismo o entidad (línea telefónica oficial, app o
        sitio web verificado).
      </footer>
    </main>
  );
}
