import type { SupabaseClient } from "@supabase/supabase-js";

export class QuotaReservationError extends Error {}

export type QuotaReservationResult = { status: "reserved" } | { status: "user_limit" } | { status: "global_limit" };

interface ReserveRpcRow {
  result: unknown;
  user_count: unknown;
  global_count: unknown;
}

// Reserva una unidad de cupo diario para un usuario, vía
// reserve_email_attempt (supabase/migrations/20260818134424_email_daily_usage.sql,
// verificada por scripts/eval-email-quota.mts). Requiere el cliente admin
// (service role) que ya usa este módulo para alerts_sent — esa función
// solo tiene GRANT EXECUTE para service_role, ni anon ni authenticated
// pueden invocarla directamente.
//
// Valida estrictamente la forma de la respuesta antes de confiar en ella:
// exactamente una fila, "result" perteneciente al enum esperado, y los dos
// contadores como enteros no negativos (se validan por defensa en
// profundidad — nunca se exponen al cliente ni se usan más allá de esta
// validación, la función solo devuelve el resultado categórico). Un error
// de Supabase o una forma inesperada de la respuesta NUNCA se interpreta
// como "cupo agotado": se distingue explícitamente con
// QuotaReservationError, que el caller trata como error interno (500), no
// como un 429.
export async function reserveEmailAttempt(admin: SupabaseClient, userId: string): Promise<QuotaReservationResult> {
  const { data, error } = await admin.rpc("reserve_email_attempt", { p_user_id: userId });

  if (error) {
    console.error("Error al reservar cupo de email:", error.message);
    throw new QuotaReservationError("No se pudo reservar el cupo de envío.");
  }

  if (!Array.isArray(data) || data.length !== 1) {
    console.error(
      "Respuesta inesperada de reserve_email_attempt (cantidad de filas):",
      Array.isArray(data) ? data.length : typeof data,
    );
    throw new QuotaReservationError("Respuesta inesperada al reservar el cupo de envío.");
  }

  const row = data[0] as ReserveRpcRow;
  const { result, user_count: userCount, global_count: globalCount } = row;

  const countsValid =
    typeof userCount === "number" &&
    Number.isInteger(userCount) &&
    userCount >= 0 &&
    typeof globalCount === "number" &&
    Number.isInteger(globalCount) &&
    globalCount >= 0;

  if (!countsValid) {
    console.error("Contadores inválidos en la respuesta de reserve_email_attempt.");
    throw new QuotaReservationError("Respuesta inesperada al reservar el cupo de envío.");
  }

  if (result === "reserved") return { status: "reserved" };
  if (result === "user_limit") return { status: "user_limit" };
  if (result === "global_limit") return { status: "global_limit" };

  console.error("Resultado inesperado de reserve_email_attempt:", result);
  throw new QuotaReservationError("Respuesta inesperada al reservar el cupo de envío.");
}

// Segundos hasta la próxima medianoche UTC — para el header Retry-After
// cuando se rechaza por límite diario (los cupos se resetean por día UTC,
// ver la migración). Siempre un entero positivo, mínimo 1 (nunca 0 ni
// negativo, por si se calcula justo en el instante del corte) y máximo
// 86400 (un día completo).
export function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  const diffMs = nextMidnight - now.getTime();
  const seconds = Math.ceil(diffMs / 1000);
  return Math.min(86400, Math.max(1, seconds));
}
