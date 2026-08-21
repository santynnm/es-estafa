// Evaluación reproducible de la extensibilidad para audio (Día 8A — sección
// 14 de indicaciones.md). NO graba, sube ni transcribe audio real: simula el
// único punto de entrada que un futuro adaptador de audio usaría — texto ya
// transcripto en otro lado, enviado como { raw_text, source_type:
// "audio_transcript" } — para probar en runtime (no solo a nivel de tipos)
// que /api/analyze, la persistencia en `checks` y la elegibilidad para
// /api/send-alert ya soportan ese pathway sin cambios adicionales.
//
// No llama a /api/send-alert (no se manda ningún email real). Hace como
// máximo UNA llamada real a Gemini (el caso representativo de riesgo). Los
// demás casos son rechazos de validación propia de /api/analyze, que
// responden antes de llamar a Gemini.
//
// Corrección puntual (post Día 8A): la elegibilidad y la limpieza de la fila
// de prueba antes marcaban PASS sin comprobar nada real (falsos positivos).
// Ahora la elegibilidad falla de verdad si risk_level no es "medio"/"alto",
// y la limpieza corre siempre (try/finally, incluso si una comprobación
// posterior al checkId falla), se verifica con una consulta posterior, y
// cualquier fallo de borrado o de verificación cuenta como fallo real de la
// evaluación (exit code distinto de cero).
//
// Uso:
//   npm run eval:audio-readiness
//   EVAL_BASE_URL=http://localhost:3000 npm run eval:audio-readiness   # contra vercel dev en local
//
// isEligibleForAlert y cleanupCheckRow se exportan para poder probarlos
// localmente sin red (ver el comentario junto al guard de main() al final
// del archivo) — no son un evaluador paralelo, son las mismas funciones que
// usa main().

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isClassifierResult, type ClassifierResult, type RiskLevel } from "../shared/classifierContract.ts";
import { getEvalAccessToken } from "./evalAuth.mts";

const BASE_URL = process.env.EVAL_BASE_URL || "https://codercup.vercel.app";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REPRESENTATIVE_RAW_TEXT =
  "Me llamaron diciendo que eran del banco y me pidieron el código que llegó por SMS para evitar el bloqueo de mi cuenta.";

let failures = 0;

function pass(label: string) {
  console.log(`- ${label} ... PASS`);
}

function fail(label: string, detail: string) {
  failures += 1;
  console.log(`- ${label} ... FAIL (${detail})`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

// Exportada para poder comprobar sin red, desde una corrida separada de este
// mismo módulo, que cualquier fail() registrado (incluido uno disparado
// dentro de runPostCheckIdVerifications) termina reflejado en
// process.exitCode — nunca un evaluador paralelo, es la misma función que
// usa main().
export function printSummary() {
  console.log(`\n${failures === 0 ? "Todas las verificaciones pasaron." : `${failures} verificación(es) fallida(s).`}`);
  if (failures > 0) process.exitCode = 1;
}

async function analyzeRequest(body: unknown, accessToken?: string) {
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

// Único criterio real de elegibilidad para esta evaluación: el caso
// representativo fue elegido para producir riesgo medio o alto (llamada
// suplantando al banco, pidiendo un código de SMS) — si el clasificador
// devuelve "bajo" para ese caso, algo está mal (calibración regresionada o
// caso mal elegido) y la evaluación tiene que fallar de verdad, no simular
// un PASS. No reimplementa la lógica real de /api/send-alert (que además
// depende de ownership/contacto/cupo) — solo el filtro por risk_level que
// esa evaluación puede comprobar sin llamar al endpoint de alertas.
export function isEligibleForAlert(riskLevel: RiskLevel): boolean {
  return riskLevel === "medio" || riskLevel === "alto";
}

// Borra la fila de prueba con el cliente admin y confirma con una consulta
// posterior que ya no existe — un DELETE de Supabase no es prueba suficiente
// por sí solo (no falla si 0 filas coincidieron). Devuelve ok:false ante
// cualquier error o si la fila sigue estando ahí, para que el caller lo
// cuente como un fallo real en vez de solo loguearlo.
export async function cleanupCheckRow(
  admin: Pick<SupabaseClient, "from">,
  checkId: string,
): Promise<{ ok: boolean; detail: string }> {
  const { error: deleteError } = await admin.from("checks").delete().eq("id", checkId);
  if (deleteError) {
    return { ok: false, detail: `error al eliminar la fila (id: ${checkId}): ${deleteError.message}` };
  }

  const { data: stillThere, error: verifyError } = await admin
    .from("checks")
    .select("id")
    .eq("id", checkId)
    .maybeSingle();
  if (verifyError) {
    return { ok: false, detail: `no se pudo verificar la eliminación (id: ${checkId}): ${verifyError.message}` };
  }
  if (stillThere) {
    return { ok: false, detail: `la fila (id: ${checkId}) sigue existiendo después del DELETE` };
  }

  return { ok: true, detail: `fila (id: ${checkId}) eliminada y verificada ausente` };
}

interface CheckRow {
  id: string;
  user_id: string;
  source_type: string;
  raw_text: string;
  risk_level: RiskLevel;
  signals: unknown;
  explanation: string;
  recommended_action: string;
}

// Todas las comprobaciones que dependen de que exista una fila real de
// `checks` identificada por checkId, más la limpieza de esa fila. Extraída
// de main() para poder ejercitarla directamente, con un cliente admin
// mockeado, en una prueba local sin red — así se reproduce el escenario
// exacto que antes terminaba en falso positivo (fila ilegible -> fail() ->
// return dentro de un try -> el finally limpia, pero la función termina ahí
// y nunca llega a fijar process.exitCode) sin necesitar producción.
//
// Deliberadamente sin ningún `return` dentro del try: un `return` ahí
// dispararía el `finally` (la limpieza corre igual) pero terminaría la
// función en cuanto el `finally` completara, saltándose el printSummary()
// que main() llama después de esperar esta función — eso es exactamente el
// falso positivo que se corrigió acá. En cambio, cada comprobación que no
// puede seguir sin datos previos se anida en un if/else: si falta esa base,
// se registra el fail() correspondiente y simplemente se omiten las
// comprobaciones que dependían de ella, sin cortar el flujo.
export async function runPostCheckIdVerifications(
  admin: Pick<SupabaseClient, "from">,
  checkId: string,
  userId: string,
  result: ClassifierResult,
): Promise<void> {
  try {
    section("Persistencia en `checks` (verificada con el cliente admin, fuera de RLS)");

    const { data: row, error: rowError } = await admin
      .from("checks")
      .select("id, user_id, source_type, raw_text, risk_level, signals, explanation, recommended_action")
      .eq("id", checkId)
      .maybeSingle<CheckRow>();

    if (rowError || !row) {
      fail("la fila persistida existe y es legible", `error: ${rowError?.message ?? "(sin fila)"}`);
    } else {
      pass("la fila persistida existe y es legible");

      if (row.user_id === userId) {
        pass("la fila pertenece al usuario de evaluación (ownership)");
      } else {
        fail("la fila pertenece al usuario de evaluación (ownership)", `user_id obtenido: ${row.user_id}`);
      }

      if (row.source_type === "audio_transcript") {
        pass('source_type persistido es exactamente "audio_transcript" (no se degradó a "text")');
      } else {
        fail('source_type persistido es "audio_transcript"', `obtenido: ${row.source_type}`);
      }

      if (row.raw_text === REPRESENTATIVE_RAW_TEXT) {
        pass("raw_text persistido coincide con el enviado");
      } else {
        fail("raw_text persistido coincide con el enviado", `obtenido: ${row.raw_text}`);
      }

      if (
        isClassifierResult({
          risk_level: row.risk_level,
          signals: row.signals,
          explanation: row.explanation,
          recommended_action: row.recommended_action,
        })
      ) {
        pass("el resultado persistido (risk_level/signals/explanation/recommended_action) es válido");
      } else {
        fail("el resultado persistido es válido", `fila: ${JSON.stringify(row)}`);
      }

      section("Elegibilidad para alerta (sin llamar a /api/send-alert, cero emails)");

      if (isEligibleForAlert(row.risk_level)) {
        pass(`risk_level obtenido ("${row.risk_level}") es elegible para alerta (medio/alto)`);
      } else {
        fail(
          `risk_level obtenido ("${row.risk_level}") es elegible para alerta (medio/alto)`,
          "el caso representativo fue elegido para producir riesgo medio o alto; un resultado \"bajo\" indica una " +
            "regresión de calibración o un caso mal elegido, no una elegibilidad confirmada",
        );
      }
      console.log(
        "  (No se llama a /api/send-alert en esta evaluación — la elegibilidad real depende también de ownership, " +
          "contacto válido, idempotencia y cupo; ninguno de esos chequeos referencia source_type, ver api/send-alert.ts.)",
      );

      console.log(
        `\nResultado del análisis clasificado: risk_level="${result.risk_level}", signals=${JSON.stringify(result.signals)}`,
      );
    }
  } catch (err) {
    fail(
      "las comprobaciones posteriores al checkId terminaron sin excepciones",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    section("Limpieza");
    try {
      const cleanup = await cleanupCheckRow(admin, checkId);
      if (cleanup.ok) {
        pass(cleanup.detail);
      } else {
        fail("fila de prueba eliminada y verificada ausente", cleanup.detail);
      }
    } catch (err) {
      fail(
        "fila de prueba eliminada y verificada ausente",
        `excepción durante la limpieza: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function main() {
  console.log(`Evaluando readiness para audio_transcript contra: ${BASE_URL}\n`);

  const accessToken = await getEvalAccessToken();

  // Necesitamos el user_id real para verificar ownership en `checks` después.
  const supabaseUrl = process.env.VITE_SUPABASE_URL!;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const anon = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
  } = await anon.auth.getUser(accessToken);
  if (!user) {
    console.error("No se pudo resolver el usuario de evaluación a partir del access token.");
    process.exit(1);
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error("Falta SUPABASE_SERVICE_ROLE_KEY — necesaria para verificar la fila persistida y limpiarla después.");
    process.exit(1);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  section("Rechazos de validación propia (sin consumir cuota de Gemini)");

  // Sin auth, también para audio_transcript.
  {
    const { status } = await analyzeRequest({ raw_text: REPRESENTATIVE_RAW_TEXT, source_type: "audio_transcript" });
    if (status === 401) {
      pass("sin auth -> 401 (audio_transcript incluido)");
    } else {
      fail("sin auth -> 401 (audio_transcript incluido)", `status obtenido: ${status}`);
    }
  }

  // raw_text vacío.
  {
    const { status } = await analyzeRequest({ raw_text: "   ", source_type: "audio_transcript" }, accessToken);
    if (status === 400) {
      pass("raw_text vacío -> 400");
    } else {
      fail("raw_text vacío -> 400", `status obtenido: ${status}`);
    }
  }

  // raw_text demasiado largo (mismo límite que text/image_ocr: 6000).
  {
    const { status } = await analyzeRequest(
      { raw_text: "a".repeat(6001), source_type: "audio_transcript" },
      accessToken,
    );
    if (status === 400) {
      pass("raw_text > 6000 caracteres -> 400 (misma regla que las otras fuentes)");
    } else {
      fail("raw_text > 6000 caracteres -> 400", `status obtenido: ${status}`);
    }
  }

  // source_type inventado.
  {
    const { status } = await analyzeRequest(
      { raw_text: REPRESENTATIVE_RAW_TEXT, source_type: "audio_file" },
      accessToken,
    );
    if (status === 400) {
      pass('source_type inventado ("audio_file") -> 400');
    } else {
      fail('source_type inventado ("audio_file") -> 400', `status obtenido: ${status}`);
    }
  }

  section("Aceptación runtime real de audio_transcript (única llamada real a Gemini)");

  const { status, headers, data } = await analyzeRequest(
    { raw_text: REPRESENTATIVE_RAW_TEXT, source_type: "audio_transcript" },
    accessToken,
  );

  if (status !== 200) {
    fail("POST /api/analyze con audio_transcript -> 200", `status obtenido: ${status} :: ${JSON.stringify(data)}`);
    console.log("\nNo se llegó a crear una fila (la request no devolvió 200) — no hay nada que limpiar.");
    printSummary();
    return;
  }
  pass("POST /api/analyze con audio_transcript -> 200");

  if (isClassifierResult(data)) {
    pass("el body de la respuesta cumple exactamente ClassifierResult");
  } else {
    fail("el body de la respuesta cumple exactamente ClassifierResult", `body: ${JSON.stringify(data)}`);
  }
  const result = data as ClassifierResult;

  const checkId = headers.get("X-Check-ID");
  if (!checkId || !UUID_PATTERN.test(checkId)) {
    fail("X-Check-ID presente y con forma de UUID", `header obtenido: ${checkId}`);
    console.log(
      "\nUn 200 implica que /api/analyze insertó una fila antes de fallar al setear el header — puede haber " +
        "quedado una fila sin identificador conocido por este script. Revisar manualmente en Supabase si hace falta.",
    );
    printSummary();
    return;
  }
  pass("X-Check-ID presente y con forma de UUID");

  // A partir de acá existe una fila de prueba real identificada por checkId.
  // runPostCheckIdVerifications hace las comprobaciones de persistencia y
  // elegibilidad y, en su propio finally, siempre intenta la limpieza —
  // nunca lanza (atrapa sus propias excepciones), así que awaitearla acá no
  // puede saltearse el printSummary() de abajo bajo ningún camino.
  await runPostCheckIdVerifications(admin, checkId, user.id, result);

  printSummary();
}

// Guard para poder importar isEligibleForAlert/cleanupCheckRow desde una
// prueba local sin red (tsx -e "...") sin disparar main() — main() solo
// corre cuando este archivo se ejecuta como script (npm run
// eval:audio-readiness), nunca al importarlo.
if (!process.env.AUDIO_READINESS_SKIP_MAIN) {
  main();
}
