import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClassifierResult } from "../../shared/classifierContract";
import { analyzeRawText, extractTextFromImage, AnalyzeError, type ImageMimeType } from "../lib/api";
import { fileToBase64, FileReadError } from "../lib/imageFile";
import { useAlertSending } from "../lib/useAlertSending";
import { ResultCard } from "./ResultCard";
import { ImageUpload } from "./ImageUpload";
import { FamilyAlert } from "./FamilyAlert";

const MAX_LENGTH = 6000;

type Mode = "text" | "image";
type Stage = "idle" | "reading" | "analyzing";

interface ActiveRequest {
  id: number;
  controller: AbortController;
}

// Analizador de texto/imagen. Desde el Día 7B guarda también el check_id que
// devuelve /api/analyze (header X-Check-ID, ver src/lib/api.ts) junto con el
// resultado, para poder ofrecer "Avisarle a un familiar" (FamilyAlert) sin
// que el backend tenga que confiar en nada que mande el cliente aparte de
// esos dos ids ya persistidos.
//
// Corrección 7B.1: ciclo de vida seguro de requests concurrentes — ver
// invalidateActiveRequest() y el comentario sobre generationRef más abajo.
export function Analyzer() {
  const { alertSending } = useAlertSending();

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

  // generationRef: contador monotónico que identifica "el análisis vigente".
  // Cada invalidación (edición de input, cambio de modo/imagen, análisis
  // nuevo, desmontaje) lo incrementa de inmediato. activeRequestRef guarda
  // el AbortController de la request en vuelo (si hay una) junto con el id
  // de generación que tenía cuando arrancó. Ninguno de los dos alcanza por
  // sí solo:
  //
  // - AbortController.abort() cancela la espera desde la perspectiva del
  //   navegador (el fetch() del cliente se rechaza con AbortError) y puede
  //   notificarle a la infraestructura de red que la conexión se cerró —
  //   pero NO garantiza que Vercel detenga la función serverless en curso,
  //   ni que se cancele una llamada a Gemini que el backend ya inició, ni
  //   que se evite el consumo de esa cuota. api/analyze.ts puede terminar
  //   de todas formas y persistir un `check` en Supabase que este cliente
  //   ya descartó — eso es una limitación conocida y aceptada, no algo que
  //   este mecanismo resuelva.
  // - Por eso una promesa que YA estaba resuelta del lado del servidor (o,
  //   en los tests, un mock que ignora el signal) puede seguir llegando al
  //   then/catch/finally del cliente igual, abortada o no — por eso cada
  //   callback async compara su propio requestId contra
  //   generationRef.current (isActive()) antes de tocar cualquier estado:
  //   esa comparación, no el abort, es la garantía real de que un
  //   resultado obsoleto nunca se muestre.
  //
  // En resumen: abort() es una optimización de ciclo de vida del lado del
  // cliente (deja de esperar, libera la UI, puede ahorrar tráfico de red),
  // no una cancelación distribuida garantizada. La única garantía real
  // contra resultados obsoletos es generación + isActive() + ownership del
  // finally (ver más abajo).
  const generationRef = useRef(0);
  const activeRequestRef = useRef<ActiveRequest | null>(null);

  const trimmedText = text.trim();
  const canSubmit =
    stage === "idle" &&
    !alertSending &&
    (mode === "text" ? trimmedText.length > 0 : imageFile !== null && !imageValidationError);

  // Única operación de invalidación: le pide al navegador que deje de
  // esperar lo que esté en vuelo (si hay algo — abort(), sin garantía de
  // cancelación server-side, ver más arriba) y deja al analizador en un
  // estado limpio, listo para un análisis nuevo sin esperar esa respuesta.
  // Se usa para los cinco disparadores de la sección A (editar texto,
  // cambiar modo, cambiar/quitar imagen, iniciar un análisis nuevo,
  // desmontar/cerrar sesión) — nunca se duplica esta lógica en otro lado.
  function invalidateActiveRequest() {
    generationRef.current += 1;
    const current = activeRequestRef.current;
    activeRequestRef.current = null;
    current?.controller.abort();
    submittingRef.current = false;
    setStage("idle");
    setResult(null);
    setCheckId(null);
    setError(null);
  }

  // Al desmontar (incluye cierre de sesión, que desmonta Analyzer desde
  // App): aborta lo que esté en vuelo pero NUNCA llama a setState — el
  // componente ya se está yendo, y tocar estado acá dispararía el warning
  // de React por actualizar un componente desmontado.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
    };
  }, []);

  function handleModeChange(nextMode: Mode) {
    if (alertSending) return;
    if (nextMode === mode) return;
    setMode(nextMode);
    invalidateActiveRequest();
    setImageValidationError(null);
  }

  function handleTextChange(value: string) {
    if (alertSending) return;
    setText(value);
    // Siempre invalida (no solo cuando ya hay result): también limpia un
    // error de un intento anterior que quedó colgado sin resultado, y le
    // avisa al fetch en vuelo (si hay uno) que el cliente dejó de esperar
    // su respuesta — sin garantía de que el análisis server-side se
    // detenga (ver el comentario junto a generationRef más arriba). Es
    // barato llamarla de más: React no re-renderiza por setear un estado
    // al mismo valor que ya tenía.
    invalidateActiveRequest();
  }

  // Centraliza el cambio de archivo (selección, cambio o "Quitar" -> null):
  // el veredicto y el error general corresponden al archivo anterior, así
  // que nunca deben seguir visibles una vez que ese archivo ya no es el
  // seleccionado. `imageValidationError` se mantiene aparte porque lo
  // administra ImageUpload para el archivo nuevo.
  function handleImageFileChange(file: File | null) {
    if (alertSending) return;
    setImageFile(file);
    invalidateActiveRequest();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (alertSending) return;
    if (submittingRef.current) return;

    if (mode === "text" ? !trimmedText : !imageFile || imageValidationError) return;

    // Invalida cualquier análisis anterior (aborta su fetch, limpia su
    // estado) y arranca inmediatamente la generación nueva sobre la que
    // corre este análisis — nada espera a que la respuesta vieja llegue.
    invalidateActiveRequest();
    const requestId = generationRef.current;
    const controller = new AbortController();
    activeRequestRef.current = { id: requestId, controller };
    const isActive = () => generationRef.current === requestId;

    submittingRef.current = true;
    setStage(mode === "text" ? "analyzing" : "reading");

    try {
      if (mode === "text") {
        const outcome = await analyzeRawText(trimmedText, "text", controller.signal);
        if (isActive()) {
          setResult(outcome.result);
          setCheckId(outcome.checkId);
        }
      } else {
        const base64 = await fileToBase64(imageFile!);
        // fileToBase64 no es abortable (lectura local, no red) — se
        // comprueba la generación antes de gastar una llamada real de OCR.
        if (!isActive()) return;
        const rawText = await extractTextFromImage(base64, imageFile!.type as ImageMimeType, controller.signal);
        if (!isActive()) return;
        setStage("analyzing");
        const outcome = await analyzeRawText(rawText, "image_ocr", controller.signal);
        if (isActive()) {
          setResult(outcome.result);
          setCheckId(outcome.checkId);
        }
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isActive() && !isAbort) {
        setError(
          err instanceof AnalyzeError || err instanceof FileReadError
            ? err.message
            : "Ocurrió un error inesperado. Probá de nuevo.",
        );
      }
    } finally {
      // Ownership del finally: solo esta request, si sigue siendo la
      // vigente, puede liberar el guard/controller y volver a "idle". Si ya
      // fue invalidada (por una edición o por un análisis B posterior), su
      // finally no toca nada — B (o el estado limpio que dejó la
      // invalidación) sigue exactamente como estaba.
      if (isActive()) {
        submittingRef.current = false;
        setStage("idle");
        activeRequestRef.current = null;
      }
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
          disabled={alertSending}
          className={`rounded-xl border-2 px-4 py-3 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
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
          disabled={alertSending}
          className={`rounded-xl border-2 px-4 py-3 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
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
              disabled={alertSending}
              placeholder='Ej: "Su tarjeta fue bloqueada. Ingrese ahora a este enlace y confirme su clave para reactivarla."'
              className="mt-2 w-full rounded-xl border-2 border-gray-300 bg-white p-4 text-base leading-relaxed text-gray-900 shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
            disabled={stage !== "idle" || alertSending}
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
