// Evaluación reproducible del mecanismo de cupos diarios de email
// (corrección 7A.2A, migración supabase/migrations/20260818134424_email_daily_usage.sql).
// Verifica límites, atomicidad, concurrencia y permisos SIN modificar la
// migración aplicada, SIN tocar los contadores reales del día y SIN llamar
// a Brevo — reutilizable después de 7A.2B como prueba de regresión de esta
// capa.
//
// Uso:
//   npm run eval:quota
//
// Variables de entorno requeridas (ver .env.example):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   — cliente anon (permisos)
//   EVAL_USER_EMAIL, EVAL_USER_PASSWORD          — usuario authenticated real (permisos)
//   SUPABASE_ACCESS_TOKEN                        — Personal Access Token de Supabase
//                                                   (Management API), solo en memoria:
//                                                   nunca se escribe a archivo, nunca se
//                                                   loguea, nunca aparece en errores.
//   SUPABASE_PROJECT_REF                         — ref del proyecto (ej. xnuxsxjqxbzwupfkdzzv)
//
// Sin SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF el script no puede crear
// el schema aislado ni comparar la función desplegada — lo informa
// explícitamente y termina con código de salida distinto de cero, sin
// inventar credenciales ni caer de vuelta a las tablas reales.

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getEvalAccessToken } from "./evalAuth.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_REL_PATH = "supabase/migrations/20260818134424_email_daily_usage.sql";
const MIGRATION_ABS_PATH = path.join(REPO_ROOT, MIGRATION_REL_PATH);
const REFERENCE_COMMIT = "9ec0081";
const SCHEMA_TEMPLATE_PATH = path.join(__dirname, "sql", "eval-email-quota-schema.sql");

let failures = 0;
function pass(label: string, detail?: unknown) {
  console.log(`  ✓ ${label}`, detail !== undefined ? detail : "");
}
function fail(label: string, detail?: unknown) {
  failures++;
  console.error(`  ✗ ${label}`, detail !== undefined ? detail : "");
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------
// Cliente para la Management API de Supabase. El token nunca se imprime,
// nunca se incluye en un mensaje de error, y nunca se escribe a un
// archivo — vive solo en la variable de entorno del proceso.
// ---------------------------------------------------------------------
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

function sanitize(message: string): string {
  if (!SUPABASE_ACCESS_TOKEN) return message;
  return message.split(SUPABASE_ACCESS_TOKEN).join("[REDACTED]");
}

async function runManagementQuery(query: string): Promise<any[]> {
  if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
    throw new Error("SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF no están configurados.");
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Management API HTTP ${res.status}: ${sanitize(text)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no-JSON de la Management API: ${sanitize(text).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------
// Paso 1: la migración versionada no fue modificada respecto al commit
// de referencia (9ec0081, donde se aplicó por última vez).
// ---------------------------------------------------------------------
function checkMigrationUnmodified(): string {
  section("Paso 1: la migración versionada no fue modificada");
  const current = readFileSync(MIGRATION_ABS_PATH, "utf-8");
  let atCommit: string;
  try {
    atCommit = execFileSync("git", ["show", `${REFERENCE_COMMIT}:${MIGRATION_REL_PATH}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
  } catch (err) {
    fail("no se pudo leer la migración en el commit de referencia", (err as Error).message);
    throw new Error("Abortando: no se pudo verificar la migración contra el commit de referencia.");
  }
  if (current !== atCommit) {
    fail(`el archivo actual difiere del commit ${REFERENCE_COMMIT}`);
    throw new Error("Abortando: la migración versionada fue modificada respecto al commit de referencia.");
  }
  pass(`archivo idéntico al commit ${REFERENCE_COMMIT}`);
  return current;
}

// Quita comentarios de línea "-- ..." antes de correr chequeos textuales —
// si no, un comentario que EXPLICA por qué no se usa SECURITY DEFINER (y
// que por lo tanto contiene esas mismas palabras) generaría un falso
// positivo al buscar la cadena literal en todo el archivo.
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// ---------------------------------------------------------------------
// Paso 2: invariantes textuales esperados en la migración (límites,
// nombres de resultado, orden de locking, incremento conjunto).
//
// evaluateMigrationInvariants() es una función PURA: solo hace
// operaciones de string sobre el texto que recibe, nunca red ni
// filesystem. Devuelve la lista completa de chequeos (con su resultado),
// para que quien la llama decida qué hacer — no depende de ningún
// contador global. Se reutiliza tal cual en dos lugares: el chequeo real
// (assertMigrationInvariants, que imprime y aborta) y el auto-test local
// de abajo (selfTestFailFast, que la corre sobre copias mutadas en
// memoria para probar que el aborto realmente dispara).
// ---------------------------------------------------------------------
interface InvariantCheck {
  label: string;
  ok: boolean;
  detail?: unknown;
}

function evaluateMigrationInvariants(migrationSqlRaw: string): InvariantCheck[] {
  const migrationSql = stripSqlLineComments(migrationSqlRaw);
  const checks: InvariantCheck[] = [];

  checks.push({ label: "límite individual = 5", ok: /v_user_count\s*>=\s*5/.test(migrationSql) });
  checks.push({ label: "límite global = 250", ok: /v_global_count\s*>=\s*250/.test(migrationSql) });

  for (const name of ["reserved", "user_limit", "global_limit"]) {
    checks.push({ label: `nombre de resultado presente: ${name}`, ok: migrationSql.includes(`'${name}'`) });
  }

  // Acota la búsqueda al cuerpo de la función (desde "create or replace
  // function" en adelante) — si no, la primera mención de cada nombre de
  // tabla es la de su CREATE TABLE, mucho antes en el archivo, y ambos
  // índices "for update" terminarían apuntando al mismo lugar.
  const functionStartIdx = migrationSql.indexOf("create or replace function");
  const userTableIdx = migrationSql.indexOf("email_user_daily_usage", functionStartIdx);
  const userForUpdateIdx = migrationSql.indexOf("for update", userTableIdx);
  const globalTableIdx = migrationSql.indexOf("email_global_daily_usage", functionStartIdx);
  const globalForUpdateIdx = migrationSql.indexOf("for update", globalTableIdx);
  // El SELECT ... FOR UPDATE de la fila global debe aparecer, en el texto,
  // después del FOR UPDATE de la fila de usuario (mismo orden que ejecuta
  // en tiempo de corrida, porque no hay ramas que inviertan ese orden).
  const lockOrderOk =
    functionStartIdx !== -1 && userForUpdateIdx !== -1 && globalForUpdateIdx !== -1 && userForUpdateIdx < globalForUpdateIdx;
  checks.push({
    label: "orden de locking: usuario antes que global (FOR UPDATE)",
    ok: lockOrderOk,
    detail: lockOrderOk ? undefined : { functionStartIdx, userForUpdateIdx, globalForUpdateIdx },
  });

  const updateMatches = migrationSql.match(/update public\.email_(user|global)_daily_usage[\s\S]*?attempt_count \+ 1/g) ?? [];
  checks.push({
    label: "dos UPDATE de incremento (individual + global), no más ni menos",
    ok: updateMatches.length === 2,
    detail: updateMatches.length === 2 ? undefined : `se encontraron ${updateMatches.length}`,
  });

  checks.push({ label: "sin SECURITY DEFINER (SECURITY INVOKER por default)", ok: !/security\s+definer/i.test(migrationSql) });

  checks.push({ label: "search_path fijado a (public, pg_temp)", ok: /set search_path\s*=\s*public\s*,\s*pg_temp/i.test(migrationSql) });

  return checks;
}

// Wrapper impuro: imprime cada chequeo y, si alguno falló, lanza de
// inmediato — ANTES de que main() llegue a tocar Supabase (comparar la
// función desplegada, crear el schema aislado, tomar snapshots, o correr
// pruebas de permisos/concurrencia). La decisión de abortar se toma sobre
// el array de resultados de ESTA llamada (variable local `failed`), no
// sobre el contador global `failures` que usan pass()/fail() para el
// resumen final.
function assertMigrationInvariants(migrationSqlRaw: string): void {
  section("Paso 2: invariantes textuales de la migración (fail-fast, sin red)");
  const checks = evaluateMigrationInvariants(migrationSqlRaw);
  for (const c of checks) {
    if (c.ok) pass(c.label);
    else fail(c.label, c.detail);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(
      `Abortando ANTES de contactar Supabase: ${failed.length} invariante(s) de la migración fallaron: ${failed.map((f) => f.label).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------
// Paso 0: auto-test del propio mecanismo fail-fast. Muta EN MEMORIA
// copias del texto de la migración real (nunca toca el archivo) y
// confirma que evaluateMigrationInvariants() detecta cada mutación como
// inválida — y que hacerlo no dispara ninguna llamada de red: mientras
// corre este auto-test, se reemplaza globalThis.fetch por una versión que
// tira una excepción si algo la invoca, así que cualquier intento de
// red (accidental o no) hace fallar el auto-test mismo, no solo lo deja
// sin detectar.
// ---------------------------------------------------------------------
function swapTableNamesInFunctionBody(sql: string): string {
  const functionStartIdx = sql.indexOf("create or replace function");
  const before = sql.slice(0, functionStartIdx);
  const after = sql.slice(functionStartIdx);
  const placeholder = "SWAP";
  const swapped = after
    .split("email_user_daily_usage")
    .join(placeholder)
    .split("email_global_daily_usage")
    .join("email_user_daily_usage")
    .split(placeholder)
    .join("email_global_daily_usage");
  return before + swapped;
}

interface Mutation {
  label: string;
  mutate: (sql: string) => string;
  expectedKeyword: string;
}

const SELF_TEST_MUTATIONS: Mutation[] = [
  {
    label: "límite individual alterado de 5 a 6",
    mutate: (sql) => sql.replace("v_user_count >= 5", "v_user_count >= 6"),
    expectedKeyword: "límite individual",
  },
  {
    label: "SECURITY DEFINER agregado a la función",
    mutate: (sql) => sql.replace("language plpgsql\nset search_path", "language plpgsql\nsecurity definer\nset search_path"),
    expectedKeyword: "SECURITY DEFINER",
  },
  {
    label: "nombre de resultado 'user_limit' renombrado",
    mutate: (sql) => sql.replace("'user_limit'::text", "'foo_limit'::text"),
    expectedKeyword: "user_limit",
  },
  {
    label: "orden de locks invertido (swap de nombres de tabla en el cuerpo de la función)",
    mutate: swapTableNamesInFunctionBody,
    expectedKeyword: "orden de locking",
  },
];

async function selfTestFailFast(realMigrationSql: string): Promise<void> {
  section("Paso 0: auto-test del mecanismo fail-fast (mutaciones en memoria, sin red)");

  const originalFetch = globalThis.fetch;
  let networkCallAttempted = false;
  globalThis.fetch = (() => {
    networkCallAttempted = true;
    throw new Error("selfTestFailFast: se intentó una llamada de red durante el auto-test — no debería pasar nunca.");
  }) as typeof fetch;

  try {
    for (const m of SELF_TEST_MUTATIONS) {
      networkCallAttempted = false;
      const mutated = m.mutate(realMigrationSql);
      if (mutated === realMigrationSql) {
        fail(`auto-test '${m.label}': la mutación no cambió nada (patrón no encontrado en el SQL real)`);
        continue;
      }
      const checks = evaluateMigrationInvariants(mutated);
      const failedLabels = checks.filter((c) => !c.ok).map((c) => c.label);
      const detected = failedLabels.some((l) => l.includes(m.expectedKeyword));
      if (failedLabels.length > 0 && detected) {
        pass(`auto-test '${m.label}': detectada correctamente`, failedLabels);
      } else {
        fail(`auto-test '${m.label}': NO fue detectada como se esperaba`, failedLabels);
      }
      if (networkCallAttempted) {
        fail(`auto-test '${m.label}': se intentó una llamada de red (no debería haber ninguna)`);
      }
    }

    // Control de cordura: el SQL real (sin mutar) tiene que seguir
    // pasando todas las invariantes — si esto fallara, sería un bug en
    // evaluateMigrationInvariants(), no en la migración.
    const realChecks = evaluateMigrationInvariants(realMigrationSql);
    const realFailed = realChecks.filter((c) => !c.ok);
    if (realFailed.length === 0) pass("el SQL real (sin mutar) pasa las invariantes — el evaluador no está siempre en falla");
    else fail("el SQL real no debería fallar ninguna invariante (bug en el evaluador)", realFailed);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------
// Paso 3: la función DESPLEGADA coincide con la de la migración, bajo una
// normalización mecánica documentada:
//   - el CUERPO plpgsql (entre los delimitadores $tag$...$tag$) se compara
//     con espacios en blanco colapsados a uno solo (Postgres reformatea
//     mayúsculas/espacios del encabezado, pero devuelve el cuerpo tal
//     cual se escribió);
//   - el ENCABEZADO se compara por partes semánticas (nombre+args, tipo de
//     retorno con sinónimos de tipo normalizados, LANGUAGE, ausencia de
//     SECURITY DEFINER, search_path), no como texto plano, porque
//     pg_get_functiondef reescribe la sintaxis (ej. "int"->"integer",
//     "set x = y" -> "SET x TO 'y'") de forma consistente pero no
//     idéntica carácter a carácter.
// Si algo no coincide, aborta ANTES de crear el schema aislado o correr
// cualquier prueba.
// ---------------------------------------------------------------------
function extractBody(sql: string): string {
  const match = sql.match(/as\s+\$([a-zA-Z_]*)\$([\s\S]*?)\$\1\$/i);
  if (!match) throw new Error("No se pudo extraer el cuerpo de la función (delimitador $tag$ no encontrado).");
  return match[2].replace(/\s+/g, " ").trim();
}

function extractNameAndArgs(sql: string): string {
  const match = sql.match(/create or replace function\s+([a-z0-9_.]+)\s*\(([^)]*)\)/i);
  if (!match) throw new Error("No se pudo extraer nombre/argumentos de la función.");
  return `${match[1].toLowerCase()}(${match[2].trim().toLowerCase()})`;
}

const TYPE_SYNONYMS: Record<string, string> = { int: "integer", int4: "integer", integer: "integer", text: "text" };
function normalizeType(t: string): string {
  return TYPE_SYNONYMS[t.trim().toLowerCase()] ?? t.trim().toLowerCase();
}

function extractReturnColumns(sql: string): string[] {
  const match = sql.match(/returns table\s*\(([^)]*)\)/i);
  if (!match) throw new Error("No se pudo extraer la firma de retorno (RETURNS TABLE).");
  return match[1]
    .split(",")
    .map((part) => {
      const [name, ...typeParts] = part.trim().split(/\s+/);
      return `${name.toLowerCase()}:${normalizeType(typeParts.join(" "))}`;
    })
    .sort();
}

function extractSearchPath(sql: string): string[] {
  const eqMatch = sql.match(/set search_path\s*=\s*([^\n;]+)/i);
  const toMatch = sql.match(/set search_path\s+to\s+([^\n;]+)/i);
  const raw = (eqMatch ?? toMatch)?.[1];
  if (!raw) throw new Error("No se pudo extraer search_path.");
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, "").toLowerCase())
    .sort();
}

async function checkDeployedFunctionMatches(migrationSql: string): Promise<void> {
  section("Paso 3: la función desplegada coincide con la migración");

  let rows: any[];
  try {
    rows = await runManagementQuery(
      "select pg_get_functiondef(oid) as def from pg_proc where proname = 'reserve_email_attempt' and pronamespace = 'public'::regnamespace;",
    );
  } catch (err) {
    fail("no se pudo consultar pg_get_functiondef vía Management API", (err as Error).message);
    throw new Error("Abortando: no se pudo obtener la definición desplegada.");
  }
  if (rows.length === 0) {
    fail("no existe public.reserve_email_attempt en el proyecto real");
    throw new Error("Abortando: la función real no existe.");
  }
  const deployedSql: string = rows[0].def;

  const checks: Array<[string, boolean, unknown?]> = [];

  try {
    const bodyMigration = extractBody(migrationSql);
    const bodyDeployed = extractBody(deployedSql);
    checks.push(["cuerpo plpgsql idéntico (whitespace normalizado)", bodyMigration === bodyDeployed]);
  } catch (err) {
    checks.push(["cuerpo plpgsql idéntico (whitespace normalizado)", false, (err as Error).message]);
  }

  try {
    checks.push(["nombre + argumentos", extractNameAndArgs(migrationSql) === extractNameAndArgs(deployedSql)]);
  } catch (err) {
    checks.push(["nombre + argumentos", false, (err as Error).message]);
  }

  try {
    const a = extractReturnColumns(migrationSql);
    const b = extractReturnColumns(deployedSql);
    checks.push(["columnas de retorno (tipos normalizados)", JSON.stringify(a) === JSON.stringify(b), { migracion: a, desplegado: b }]);
  } catch (err) {
    checks.push(["columnas de retorno (tipos normalizados)", false, (err as Error).message]);
  }

  checks.push(["LANGUAGE plpgsql en ambas", /language\s+plpgsql/i.test(migrationSql) && /language\s+plpgsql/i.test(deployedSql)]);
  // Se compara sobre el texto SIN comentarios de línea: la migración
  // explica en un comentario por qué NO se usa SECURITY DEFINER, y esa
  // explicación menciona la frase literal — sin quitar comentarios daría
  // un falso positivo. pg_get_functiondef nunca incluye comentarios, así
  // que stripSqlLineComments es un no-op sobre deployedSql.
  checks.push([
    "sin SECURITY DEFINER en ninguna de las dos",
    !/security\s+definer/i.test(stripSqlLineComments(migrationSql)) && !/security\s+definer/i.test(stripSqlLineComments(deployedSql)),
  ]);

  try {
    const a = extractSearchPath(migrationSql);
    const b = extractSearchPath(deployedSql);
    checks.push(["search_path equivalente", JSON.stringify(a) === JSON.stringify(b), { migracion: a, desplegado: b }]);
  } catch (err) {
    checks.push(["search_path equivalente", false, (err as Error).message]);
  }

  let anyMismatch = false;
  for (const [label, ok, detail] of checks) {
    if (ok) pass(label);
    else {
      fail(label, detail);
      anyMismatch = true;
    }
  }

  if (anyMismatch) {
    throw new Error("Abortando: la función desplegada NO coincide con la migración versionada — no se crea el schema aislado.");
  }
}

// ---------------------------------------------------------------------
// Paso 4: permisos sobre los objetos REALES (public.*). anon y
// authenticated deben ser rechazados ANTES de que la función/tabla se
// toque — un rechazo de permisos no ejecuta el cuerpo de la función ni
// modifica ninguna fila, así que estas pruebas no consumen cupo real.
// service_role se verifica por catálogo (has_function_privilege /
// has_table_privilege), sin invocar la función — así tampoco consume
// una reserva real.
// ---------------------------------------------------------------------
async function checkPermissions(): Promise<void> {
  section("Paso 4: permisos sobre las tablas y la función reales");

  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    fail("faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
    return;
  }
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let token: string;
  try {
    token = await getEvalAccessToken();
  } catch (err) {
    fail("no se pudo autenticar el usuario de evaluación", (err as Error).message);
    return;
  }
  const authed = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

  async function expectDenied(label: string, op: () => PromiseLike<{ error: { code?: string } | null }>) {
    const { error } = await op();
    if (error && error.code === "42501") pass(label);
    else fail(label, { error });
  }

  await expectDenied("anon: SELECT email_user_daily_usage -> denegado", () => anon.from("email_user_daily_usage").select("*").limit(1));
  await expectDenied("anon: SELECT email_global_daily_usage -> denegado", () => anon.from("email_global_daily_usage").select("*").limit(1));
  await expectDenied("anon: INSERT email_user_daily_usage -> denegado", () =>
    anon.from("email_user_daily_usage").insert({ user_id: FAKE_UUID, usage_date: "1999-01-01", attempt_count: 1 }),
  );
  await expectDenied("anon: RPC reserve_email_attempt -> denegado", () => anon.rpc("reserve_email_attempt", { p_user_id: FAKE_UUID }));

  await expectDenied("authenticated: SELECT email_user_daily_usage -> denegado", () =>
    authed.from("email_user_daily_usage").select("*").limit(1),
  );
  await expectDenied("authenticated: SELECT email_global_daily_usage -> denegado", () =>
    authed.from("email_global_daily_usage").select("*").limit(1),
  );
  await expectDenied("authenticated: UPDATE email_global_daily_usage -> denegado", () =>
    authed.from("email_global_daily_usage").update({ attempt_count: 0 }).eq("usage_date", "1999-01-01"),
  );
  await expectDenied("authenticated: DELETE email_user_daily_usage -> denegado", () =>
    authed.from("email_user_daily_usage").delete().eq("usage_date", "1999-01-01"),
  );
  await expectDenied("authenticated: RPC reserve_email_attempt -> denegado", () =>
    authed.rpc("reserve_email_attempt", { p_user_id: FAKE_UUID }),
  );

  // service_role: chequeo por catálogo, SIN ejecutar la función (no
  // consume ninguna reserva real).
  try {
    const rows = await runManagementQuery(`
      select
        has_function_privilege('service_role', 'public.reserve_email_attempt(uuid)', 'EXECUTE') as service_role_execute,
        has_function_privilege('anon', 'public.reserve_email_attempt(uuid)', 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', 'public.reserve_email_attempt(uuid)', 'EXECUTE') as authenticated_execute,
        has_table_privilege('service_role', 'public.email_user_daily_usage', 'SELECT') as service_role_select_user,
        has_table_privilege('anon', 'public.email_user_daily_usage', 'SELECT') as anon_select_user,
        has_table_privilege('authenticated', 'public.email_user_daily_usage', 'SELECT') as authenticated_select_user;
    `);
    const r = rows[0];
    if (r.service_role_execute === true) pass("service_role: EXECUTE sobre reserve_email_attempt (catálogo, sin invocar)");
    else fail("service_role: EXECUTE esperado por catálogo", r);
    if (r.anon_execute === false && r.authenticated_execute === false) pass("anon/authenticated: sin EXECUTE por catálogo");
    else fail("anon/authenticated no deberían tener EXECUTE por catálogo", r);
    if (r.service_role_select_user === true) pass("service_role: SELECT sobre email_user_daily_usage (catálogo)");
    else fail("service_role: SELECT esperado por catálogo", r);
    if (r.anon_select_user === false && r.authenticated_select_user === false) pass("anon/authenticated: sin SELECT por catálogo");
    else fail("anon/authenticated no deberían tener SELECT por catálogo", r);
  } catch (err) {
    fail("no se pudo consultar has_function_privilege/has_table_privilege", (err as Error).message);
  }
}

// ---------------------------------------------------------------------
// Snapshot con digest exacto — reemplaza el snapshot anterior (solo
// conteo + suma de attempt_count), que no detectaría, por ejemplo, dos
// filas que intercambiaran su attempt_count entre sí, o un updated_at
// alterado sin cambiar el conteo. Para cada tabla se arma una
// representación canónica de TODAS sus filas y columnas relevantes (clave
// primaria + attempt_count + updated_at), en un orden estable
// (user_id, usage_date para la individual; usage_date para la global), y
// se calcula un md5 sobre esa representación — todo en SQL, así nunca
// viaja a Node ni se imprime una fila cruda o un UUID: lo único que sale
// de la consulta es el conteo y el digest, ambos opacos.
//
// updated_at se normaliza con extract(epoch from ...) para no depender de
// cómo el servidor serialice un timestamptz a texto (evita falsos
// positivos por formato, sin perder precisión real).
//
// schema es "public" (constante) para el snapshot real, o un nombre de
// schema aislado ya validado por assertValidSchemaName cuando se reutiliza
// esta misma función para el auto-test del comparador (ver
// selfTestDigestComparator).
function buildTableDigestQuery(schema: string): string {
  if (schema !== "public") assertValidSchemaName(schema);
  return `
    select 'email_user_daily_usage' as table_name, count(*) as row_count,
      md5(coalesce(string_agg(
        user_id::text || '|' || usage_date::text || '|' || attempt_count::text || '|' || extract(epoch from updated_at)::text,
        ';' order by user_id, usage_date
      ), '')) as digest
    from ${schema}.email_user_daily_usage
    union all
    select 'email_global_daily_usage', count(*),
      md5(coalesce(string_agg(
        usage_date::text || '|' || attempt_count::text || '|' || extract(epoch from updated_at)::text,
        ';' order by usage_date
      ), ''))
    from ${schema}.email_global_daily_usage;
  `;
}

interface TableDigest {
  rowCount: number;
  digest: string;
}

async function snapshotTables(schema: string): Promise<Record<string, TableDigest>> {
  const rows = await runManagementQuery(buildTableDigestQuery(schema));
  const result: Record<string, TableDigest> = {};
  for (const r of rows) {
    result[r.table_name] = { rowCount: Number(r.row_count), digest: r.digest as string };
  }
  return result;
}

function snapshotsEqual(a: Record<string, TableDigest>, b: Record<string, TableDigest>): boolean {
  const tables = ["email_user_daily_usage", "email_global_daily_usage"];
  return tables.every((t) => a[t]?.rowCount === b[t]?.rowCount && a[t]?.digest === b[t]?.digest);
}

// ---------------------------------------------------------------------
// Auto-test del comparador de digests, dentro del schema aislado (nunca
// contra las tablas reales): arma dos estados con la MISMA cantidad de
// filas — de hecho la misma fila — donde lo único que cambia es
// updated_at (attempt_count y la clave primaria quedan iguales), y
// confirma que el digest sí lo detecta. Reutiliza exactamente
// buildTableDigestQuery()/snapshotTables(), así prueba el comparador
// real, no una reimplementación paralela.
// ---------------------------------------------------------------------
async function selfTestDigestComparator(schema: string): Promise<void> {
  section("Paso 5.6: auto-test del comparador de digests (mismo conteo, contenido distinto)");
  const DIGEST_TEST_USER = "33333333-3333-4333-8333-333333333333";
  const DIGEST_TEST_DATE = "2000-01-09";

  await runManagementQuery(
    `insert into ${schema}.email_user_daily_usage (user_id, usage_date, attempt_count, updated_at) ` +
      `values ('${DIGEST_TEST_USER}'::uuid, '${DIGEST_TEST_DATE}'::date, 2, '2000-01-09T00:00:00Z'::timestamptz);`,
  );
  const stateA = await snapshotTables(schema);

  // Mismo conteo de filas, mismo attempt_count (misma suma) — solo cambia
  // updated_at. El snapshot anterior (conteo + suma) NO habría detectado
  // esto; el digest sí tiene que hacerlo.
  await runManagementQuery(
    `update ${schema}.email_user_daily_usage set updated_at = '2000-01-09T00:00:05Z'::timestamptz ` +
      `where user_id = '${DIGEST_TEST_USER}'::uuid and usage_date = '${DIGEST_TEST_DATE}'::date;`,
  );
  const stateB = await snapshotTables(schema);

  const sameRowCount = stateA.email_user_daily_usage.rowCount === stateB.email_user_daily_usage.rowCount;
  const differentDigest = stateA.email_user_daily_usage.digest !== stateB.email_user_daily_usage.digest;

  if (sameRowCount) pass("mismo conteo de filas entre los dos estados (como se esperaba)");
  else fail("el conteo de filas debería ser igual entre los dos estados", { stateA, stateB });

  if (differentDigest) pass("el digest SÍ detecta el cambio de updated_at aunque el conteo no cambió", {
    digestA: stateA.email_user_daily_usage.digest,
    digestB: stateB.email_user_daily_usage.digest,
  });
  else fail("el digest debería haber cambiado tras modificar updated_at", stateA.email_user_daily_usage.digest);
}

// ---------------------------------------------------------------------
// Schema aislado: nombre generado con 8 bytes aleatorios (16 hex),
// validado estrictamente ANTES de interpolarlo en cualquier SQL. Nunca
// se usa un nombre que no haya pasado por este validador.
// ---------------------------------------------------------------------
const RESERVED_SCHEMAS = new Set(["public", "auth", "storage", "extensions", "graphql_public", "pg_catalog", "information_schema"]);
const SCHEMA_NAME_PATTERN = /^quota_eval_[0-9a-f]{16}$/;

function generateSchemaName(): string {
  return `quota_eval_${randomBytes(8).toString("hex")}`;
}

function assertValidSchemaName(name: string): void {
  if (!SCHEMA_NAME_PATTERN.test(name)) {
    throw new Error(`Nombre de schema inválido, se rechaza: ${name}`);
  }
  if (RESERVED_SCHEMAS.has(name)) {
    throw new Error(`Nombre de schema reservado, se rechaza: ${name}`);
  }
}

async function dropSchemaIfExists(name: string): Promise<void> {
  assertValidSchemaName(name);
  await runManagementQuery(`drop schema if exists ${name} cascade;`);
}

async function schemaExists(name: string): Promise<boolean> {
  assertValidSchemaName(name);
  const rows = await runManagementQuery(`select 1 as found from pg_namespace where nspname = '${name}';`);
  return rows.length > 0;
}

async function createIsolatedSchema(name: string): Promise<void> {
  assertValidSchemaName(name);
  const template = readFileSync(SCHEMA_TEMPLATE_PATH, "utf-8");
  const sql = template.split("__SCHEMA__").join(name);
  await runManagementQuery(sql);
}

async function reserveInSchema(schema: string, userId: string, date: string): Promise<{ result: string; user_count: number; global_count: number } | { error: string }> {
  assertValidSchemaName(schema);
  const userIdLiteral = userId === "null" ? "null" : `'${userId}'::uuid`;
  try {
    const rows = await runManagementQuery(`select * from ${schema}.reserve_email_attempt(${userIdLiteral}, '${date}'::date);`);
    return rows[0];
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function getSchemaCount(schema: string, table: "user" | "global", userId: string | null, date: string): Promise<number> {
  assertValidSchemaName(schema);
  const tableName = table === "user" ? "email_user_daily_usage" : "email_global_daily_usage";
  const where = table === "user" ? `user_id = '${userId}'::uuid and usage_date = '${date}'::date` : `usage_date = '${date}'::date`;
  const rows = await runManagementQuery(`select coalesce((select attempt_count from ${schema}.${tableName} where ${where}), 0) as c;`);
  return Number(rows[0].c);
}

// ---------------------------------------------------------------------
// Paso 5: pruebas funcionales dentro del schema aislado.
// ---------------------------------------------------------------------
async function runFunctionalTests(schema: string): Promise<void> {
  section("Paso 5: pruebas funcionales en el schema aislado");

  const USER_A = "11111111-1111-4111-8111-111111111111";
  const USER_B = "22222222-2222-4222-8222-222222222222";

  const DATE_SEQUENTIAL = "2000-01-01";
  const DATE_USER_RACE = "2000-01-02";
  const DATE_GLOBAL_RACE = "2000-01-03";
  const DATE_PERIOD_A = "2000-01-04";
  const DATE_PERIOD_B = "2000-01-05";
  const DATE_NULL_USER = "2000-01-06";

  // --- 5.1: cinco reservas secuenciales -> reserved, la sexta -> user_limit ---
  const sequentialResults: any[] = [];
  for (let i = 1; i <= 6; i++) {
    sequentialResults.push(await reserveInSchema(schema, USER_A, DATE_SEQUENTIAL));
  }
  const firstFive = sequentialResults.slice(0, 5);
  const sixth = sequentialResults[5];
  if (firstFive.every((r) => r.result === "reserved")) pass("intentos 1-5 -> reserved", firstFive.map((r) => r.user_count));
  else fail("se esperaba 'reserved' en los intentos 1-5", firstFive);
  if (sixth.result === "user_limit") pass("intento 6 -> user_limit");
  else fail("se esperaba 'user_limit' en el intento 6", sixth);

  const userCountSeq = await getSchemaCount(schema, "user", USER_A, DATE_SEQUENTIAL);
  const globalCountSeq = await getSchemaCount(schema, "global", null, DATE_SEQUENTIAL);
  if (userCountSeq === 5) pass("contador individual final = 5");
  else fail("contador individual final debería ser 5", userCountSeq);
  if (globalCountSeq === 5) pass("la 6ta reserva (rechazada) no incrementó el global (sigue en 5)");
  else fail("el rechazo #6 no debería haber tocado el global", globalCountSeq);

  // --- 5.2: contador individual en 4, dos reservas simultáneas del MISMO usuario ---
  await runManagementQuery(
    `insert into ${schema}.email_user_daily_usage (user_id, usage_date, attempt_count) values ('${USER_A}'::uuid, '${DATE_USER_RACE}'::date, 4);` +
      `insert into ${schema}.email_global_daily_usage (usage_date, attempt_count) values ('${DATE_USER_RACE}'::date, 0);`,
  );
  const [ur1, ur2] = await Promise.all([reserveInSchema(schema, USER_A, DATE_USER_RACE), reserveInSchema(schema, USER_A, DATE_USER_RACE)]);
  const userRaceResults = [ur1, ur2] as any[];
  const reservedU = userRaceResults.filter((r) => r.result === "reserved").length;
  const userLimitU = userRaceResults.filter((r) => r.result === "user_limit").length;
  if (reservedU === 1 && userLimitU === 1) pass("carrera individual: exactamente 1 reserved y 1 user_limit", userRaceResults);
  else fail("carrera individual: se esperaba exactamente 1 reserved y 1 user_limit", userRaceResults);
  const userCountRace = await getSchemaCount(schema, "user", USER_A, DATE_USER_RACE);
  const globalCountUserRace = await getSchemaCount(schema, "global", null, DATE_USER_RACE);
  if (userCountRace === 5) pass("carrera individual: contador individual final = 5");
  else fail("carrera individual: contador individual final debería ser 5", userCountRace);
  if (globalCountUserRace === 1) pass("carrera individual: un solo incremento global (el que ganó)");
  else fail("carrera individual: se esperaba exactamente 1 incremento global", globalCountUserRace);

  // --- 5.3: contador global en 249, dos reservas simultáneas de USUARIOS DISTINTOS ---
  await runManagementQuery(`insert into ${schema}.email_global_daily_usage (usage_date, attempt_count) values ('${DATE_GLOBAL_RACE}'::date, 249);`);
  const startA = Date.now();
  const [gr1, gr2] = await Promise.all([reserveInSchema(schema, USER_A, DATE_GLOBAL_RACE), reserveInSchema(schema, USER_B, DATE_GLOBAL_RACE)]);
  const elapsedMs = Date.now() - startA;
  console.log(`  (dos requests concurrentes resueltas en ${elapsedMs}ms — Promise.all, conexiones HTTP/DB separadas)`);
  const globalRaceResults = [gr1, gr2] as any[];
  const reservedG = globalRaceResults.filter((r) => r.result === "reserved").length;
  const globalLimitG = globalRaceResults.filter((r) => r.result === "global_limit").length;
  if (reservedG === 1 && globalLimitG === 1) pass("carrera global: exactamente 1 reserved y 1 global_limit", globalRaceResults);
  else fail("carrera global: se esperaba exactamente 1 reserved y 1 global_limit", globalRaceResults);
  const globalCountRace = await getSchemaCount(schema, "global", null, DATE_GLOBAL_RACE);
  if (globalCountRace === 250) pass("carrera global: contador global final = 250");
  else fail("carrera global: contador global final debería ser 250", globalCountRace);
  const loserIsA = (gr1 as any).result === "global_limit";
  const loserId = loserIsA ? USER_A : USER_B;
  const loserUserCount = await getSchemaCount(schema, "user", loserId, DATE_GLOBAL_RACE);
  if (loserUserCount === 0) pass("carrera global: el que perdió por límite global no incrementó su contador individual");
  else fail("el perdedor por límite global no debería haber incrementado su contador individual", loserUserCount);

  // --- 5.4: dos fechas UTC distintas mantienen contadores independientes ---
  await reserveInSchema(schema, USER_A, DATE_PERIOD_A);
  await reserveInSchema(schema, USER_A, DATE_PERIOD_A);
  await reserveInSchema(schema, USER_A, DATE_PERIOD_B);
  const countPeriodA = await getSchemaCount(schema, "user", USER_A, DATE_PERIOD_A);
  const countPeriodB = await getSchemaCount(schema, "user", USER_A, DATE_PERIOD_B);
  if (countPeriodA === 2 && countPeriodB === 1) pass("períodos UTC distintos mantienen contadores independientes", { countPeriodA, countPeriodB });
  else fail("los períodos deberían ser independientes", { countPeriodA, countPeriodB });

  // --- 5.5: user_id nulo es rechazado ---
  const nullResult = await reserveInSchema(schema, "null", DATE_NULL_USER);
  if ("error" in nullResult && /user_id_required/.test(nullResult.error)) pass("user_id nulo -> rechazado con user_id_required");
  else fail("se esperaba un rechazo con user_id_required para user_id nulo", nullResult);
}

// ---------------------------------------------------------------------
// Paso 6: prueba dedicada de limpieza — fuerza un fallo DESPUÉS de crear
// un schema (distinto del principal) y confirma que el bloque finally lo
// elimina de todas formas.
// ---------------------------------------------------------------------
async function testCleanupOnForcedFailure(): Promise<void> {
  section("Paso 6: limpieza garantizada ante un fallo forzado");
  const schemaName = generateSchemaName();
  let forcedErrorCaught = false;
  try {
    try {
      await createIsolatedSchema(schemaName);
      pass(`schema de prueba de fallo creado: ${schemaName}`);
      throw new Error("fallo forzado deliberado (esperado) — verifica que finally limpia igual");
    } finally {
      await dropSchemaIfExists(schemaName);
    }
  } catch (err) {
    if ((err as Error).message.includes("fallo forzado deliberado")) {
      forcedErrorCaught = true;
    } else {
      fail("error inesperado durante la prueba de limpieza", (err as Error).message);
    }
  }
  if (!forcedErrorCaught) fail("no se disparó el fallo forzado esperado");

  const stillExists = await schemaExists(schemaName);
  if (!stillExists) pass("el schema fue eliminado por finally a pesar del fallo forzado");
  else fail("el schema NO fue eliminado tras el fallo forzado", schemaName);
}

// ---------------------------------------------------------------------
// Orquestación principal.
// ---------------------------------------------------------------------
async function main() {
  console.log("Evaluación de cupos diarios de email — corrección 7A.2A.2");
  console.log("No llama a Brevo. No modifica las tablas reales de cupo. No envía emails.\n");

  // Pasos 1, 2 y 0: SOLO archivo local + git + operaciones de string, CERO
  // requests a Supabase. Se corren antes de siquiera revisar si hay
  // credenciales — si la migración está rota, no hace falta token para
  // saberlo.
  let migrationSql: string;
  try {
    migrationSql = checkMigrationUnmodified();
    assertMigrationInvariants(migrationSql);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  await selfTestFailFast(migrationSql);
  if (failures > 0) {
    console.error(`\n=== Resultado final: ${failures} verificación(es) fallida(s) en el auto-test local ===`);
    process.exitCode = 1;
    return;
  }

  if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
    console.error(
      "\nBLOQUEADO: faltan SUPABASE_ACCESS_TOKEN y/o SUPABASE_PROJECT_REF.\n" +
        "Las verificaciones locales (migración sin modificar, invariantes, auto-test\n" +
        "fail-fast) ya pasaron sin necesitar ninguna credencial. Pero sin esas dos\n" +
        "variables no se puede comparar la función desplegada ni crear el schema aislado\n" +
        "para el resto de las pruebas — no se va a usar ninguna alternativa insegura (como\n" +
        "operar contra las tablas reales). Definilas solo en memoria de tu shell (nunca en\n" +
        ".env ni en ningún archivo del repo) y volvé a correr `npm run eval:quota`.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    await checkDeployedFunctionMatches(migrationSql);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  await checkPermissions();

  const before = await snapshotTables("public");
  console.log(
    `\n(snapshot ANTES — public.email_user_daily_usage: ${before.email_user_daily_usage.rowCount} filas, digest ${before.email_user_daily_usage.digest}; public.email_global_daily_usage: ${before.email_global_daily_usage.rowCount} filas, digest ${before.email_global_daily_usage.digest})`,
  );

  const schema = generateSchemaName();
  assertValidSchemaName(schema);
  try {
    await createIsolatedSchema(schema);
    console.log(`\nschema aislado creado: ${schema}`);
    await runFunctionalTests(schema);
    await selfTestDigestComparator(schema);
  } catch (err) {
    fail("error durante las pruebas funcionales en el schema aislado", (err as Error).message);
  } finally {
    await dropSchemaIfExists(schema);
    console.log(`schema aislado eliminado: ${schema}`);
  }

  await testCleanupOnForcedFailure();

  section("Paso 7: no quedaron schemas de evaluación y las tablas reales no cambiaron");
  // Patrón EXACTO (con ^ y $) — nunca "like 'quota_eval_%'", que también
  // matchearía cualquier schema cuyo nombre solo empiece parecido.
  const leftoverRows = await runManagementQuery("select nspname from pg_namespace where nspname ~ '^quota_eval_[0-9a-f]{16}$';");
  if (leftoverRows.length === 0) pass("no queda ningún schema que matchee ^quota_eval_[0-9a-f]{16}$ en pg_namespace");
  else fail("quedaron schemas de evaluación sin eliminar", leftoverRows);

  const after = await snapshotTables("public");
  console.log(
    `(snapshot DESPUÉS — public.email_user_daily_usage: ${after.email_user_daily_usage.rowCount} filas, digest ${after.email_user_daily_usage.digest}; public.email_global_daily_usage: ${after.email_global_daily_usage.rowCount} filas, digest ${after.email_global_daily_usage.digest})`,
  );
  if (snapshotsEqual(before, after)) pass("las tablas reales de cupo quedaron exactamente iguales (mismo conteo y mismo digest)");
  else fail("las tablas reales de cupo cambiaron durante la evaluación", { before, after });

  console.log(`\n=== Resultado final: ${failures === 0 ? "TODO OK" : `${failures} verificación(es) fallida(s)`} ===`);
  console.log("Confirmado: cero llamadas a Brevo, cero emails enviados durante esta evaluación.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Error no controlado:", sanitize((err as Error).message ?? String(err)));
  process.exitCode = 1;
});
