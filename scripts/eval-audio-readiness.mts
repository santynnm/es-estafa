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
// Uso:
//   npm run eval:audio-readiness
//   EVAL_BASE_URL=http://localhost:3000 npm run eval:audio-readiness   # contra vercel dev en local

import { createClient } from "@supabase/supabase-js";
import { isClassifierResult, type ClassifierResult } from "../shared/classifierContract.ts";
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
    console.log(`\n${failures} verificación(es) fallida(s). No se puede continuar sin una respuesta 200.`);
    process.exitCode = 1;
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
  if (checkId && UUID_PATTERN.test(checkId)) {
    pass("X-Check-ID presente y con forma de UUID");
  } else {
    fail("X-Check-ID presente y con forma de UUID", `header obtenido: ${checkId}`);
    console.log(`\n${failures} verificación(es) fallida(s). No se puede continuar sin un check_id válido.`);
    process.exitCode = 1;
    return;
  }

  section("Persistencia en `checks` (verificada con el cliente admin, fuera de RLS)");

  interface CheckRow {
    id: string;
    user_id: string;
    source_type: string;
    raw_text: string;
    risk_level: string;
    signals: unknown;
    explanation: string;
    recommended_action: string;
  }

  const { data: row, error: rowError } = await admin
    .from("checks")
    .select("id, user_id, source_type, raw_text, risk_level, signals, explanation, recommended_action")
    .eq("id", checkId)
    .maybeSingle<CheckRow>();

  if (rowError || !row) {
    fail("la fila persistida existe y es legible", `error: ${rowError?.message ?? "(sin fila)"}`);
    console.log(`\n${failures} verificación(es) fallida(s).`);
    process.exitCode = 1;
    return;
  }
  pass("la fila persistida existe y es legible");

  if (row.user_id === user.id) {
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

  const wouldBeEligible = row.risk_level !== "bajo";
  console.log(
    `  risk_level obtenido: "${row.risk_level}" -> ${
      wouldBeEligible ? "sería elegible para una alerta (medio/alto)" : "no sería elegible (bajo)"
    }.`,
  );
  console.log(
    "  (No se llama a /api/send-alert en esta evaluación — la elegibilidad real depende únicamente de ownership, " +
      "risk_level, contacto válido, idempotencia y cupo; ninguno de esos chequeos referencia source_type, ver api/send-alert.ts.)",
  );
  pass("inspección de elegibilidad completada sin invocar /api/send-alert");

  section("Limpieza");

  const { error: deleteError } = await admin.from("checks").delete().eq("id", checkId);
  if (deleteError) {
    console.log(
      `  No se pudo eliminar automáticamente la fila de prueba (id: ${checkId}). Queda documentada acá para` +
        ` borrado manual si hace falta. Motivo: ${deleteError.message}`,
    );
  } else {
    console.log(`  Fila de prueba (id: ${checkId}) eliminada correctamente.`);
  }

  console.log(`\nResultado del análisis clasificado: risk_level="${result.risk_level}", signals=${JSON.stringify(result.signals)}`);
  console.log(`\n${failures === 0 ? "Todas las verificaciones pasaron." : `${failures} verificación(es) fallida(s).`}`);
  if (failures > 0) process.exitCode = 1;
}

main();
