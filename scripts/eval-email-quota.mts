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
// ---------------------------------------------------------------------
function checkMigrationInvariants(migrationSqlRaw: string) {
  section("Paso 2: invariantes textuales de la migración");
  const migrationSql = stripSqlLineComments(migrationSqlRaw);

  if (/v_user_count\s*>=\s*5/.test(migrationSql)) pass("límite individual = 5");
  else fail("no se encontró el límite individual (>= 5)");

  if (/v_global_count\s*>=\s*250/.test(migrationSql)) pass("límite global = 250");
  else fail("no se encontró el límite global (>= 250)");

  for (const name of ["reserved", "user_limit", "global_limit"]) {
    if (migrationSql.includes(`'${name}'`)) pass(`nombre de resultado presente: ${name}`);
    else fail(`falta el nombre de resultado: ${name}`);
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
  if (
    functionStartIdx !== -1 &&
    userForUpdateIdx !== -1 &&
    globalForUpdateIdx !== -1 &&
    userForUpdateIdx < globalForUpdateIdx
  ) {
    pass("orden de locking: usuario antes que global (FOR UPDATE)");
  } else {
    fail("no se pudo confirmar el orden de locking usuario->global", { functionStartIdx, userForUpdateIdx, globalForUpdateIdx });
  }

  const updateMatches = migrationSql.match(/update public\.email_(user|global)_daily_usage[\s\S]*?attempt_count \+ 1/g) ?? [];
  if (updateMatches.length === 2) pass("dos UPDATE de incremento (individual + global), no más ni menos");
  else fail(`se esperaban exactamente 2 UPDATE de incremento, se encontraron ${updateMatches.length}`);

  if (/security\s+definer/i.test(migrationSql)) fail("la migración usa SECURITY DEFINER (se esperaba SECURITY INVOKER)");
  else pass("sin SECURITY DEFINER (SECURITY INVOKER por default)");

  if (/set search_path\s*=\s*public\s*,\s*pg_temp/i.test(migrationSql)) pass("search_path fijado a (public, pg_temp)");
  else fail("no se encontró el search_path esperado");
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
// Snapshot de las tablas reales — para confirmar, al final, que esta
// evaluación no las tocó.
// ---------------------------------------------------------------------
async function snapshotRealTables(): Promise<{ userRows: number; globalRows: number; userSum: number; globalSum: number }> {
  const rows = await runManagementQuery(`
    select
      (select count(*) from public.email_user_daily_usage) as user_rows,
      (select coalesce(sum(attempt_count), 0) from public.email_user_daily_usage) as user_sum,
      (select count(*) from public.email_global_daily_usage) as global_rows,
      (select coalesce(sum(attempt_count), 0) from public.email_global_daily_usage) as global_sum;
  `);
  const r = rows[0];
  return { userRows: Number(r.user_rows), userSum: Number(r.user_sum), globalRows: Number(r.global_rows), globalSum: Number(r.global_sum) };
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
  console.log("Evaluación de cupos diarios de email — corrección 7A.2A.1");
  console.log("No llama a Brevo. No modifica las tablas reales de cupo. No envía emails.\n");

  if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
    console.error(
      "BLOQUEADO: faltan SUPABASE_ACCESS_TOKEN y/o SUPABASE_PROJECT_REF.\n" +
        "Sin esas variables no se puede comparar la función desplegada ni crear el schema\n" +
        "aislado para las pruebas — no se va a usar ninguna alternativa insegura (como\n" +
        "operar contra las tablas reales). Definilas solo en memoria de tu shell (nunca en\n" +
        ".env ni en ningún archivo del repo) y volvé a correr `npm run eval:quota`.",
    );
    process.exitCode = 1;
    return;
  }

  let migrationSql: string;
  try {
    migrationSql = checkMigrationUnmodified();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  checkMigrationInvariants(migrationSql);

  try {
    await checkDeployedFunctionMatches(migrationSql);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  await checkPermissions();

  const before = await snapshotRealTables();
  console.log(`\n(snapshot de las tablas reales ANTES: ${JSON.stringify(before)})`);

  const schema = generateSchemaName();
  assertValidSchemaName(schema);
  try {
    await createIsolatedSchema(schema);
    console.log(`\nschema aislado creado: ${schema}`);
    await runFunctionalTests(schema);
  } catch (err) {
    fail("error durante las pruebas funcionales en el schema aislado", (err as Error).message);
  } finally {
    await dropSchemaIfExists(schema);
    console.log(`schema aislado eliminado: ${schema}`);
  }

  await testCleanupOnForcedFailure();

  section("Paso 7: no quedaron schemas de evaluación y las tablas reales no cambiaron");
  const leftoverRows = await runManagementQuery("select nspname from pg_namespace where nspname like 'quota_eval_%';");
  if (leftoverRows.length === 0) pass("no queda ningún schema quota_eval_* en pg_namespace");
  else fail("quedaron schemas de evaluación sin eliminar", leftoverRows);

  const after = await snapshotRealTables();
  console.log(`(snapshot de las tablas reales DESPUÉS: ${JSON.stringify(after)})`);
  if (JSON.stringify(before) === JSON.stringify(after)) pass("las tablas reales de cupo quedaron exactamente iguales");
  else fail("las tablas reales de cupo cambiaron durante la evaluación", { before, after });

  console.log(`\n=== Resultado final: ${failures === 0 ? "TODO OK" : `${failures} verificación(es) fallida(s)`} ===`);
  console.log("Confirmado: cero llamadas a Brevo, cero emails enviados durante esta evaluación.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Error no controlado:", sanitize((err as Error).message ?? String(err)));
  process.exitCode = 1;
});
