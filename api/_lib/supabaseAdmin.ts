import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class AdminConfigError extends Error {}

let cachedAdminClient: SupabaseClient | null = null;

// Cliente administrativo (service role) — server-only, nunca importado desde
// src/. Se usa exclusivamente para reclamar y actualizar filas de
// alerts_sent (ver api/send-alert.ts), porque esa tabla ya no tiene ninguna
// política de INSERT/UPDATE para el rol "authenticated": la única forma de
// crear o transicionar una alerta es a través de este cliente, controlado
// enteramente por nuestro código server-side.
//
// checks y family_contacts siguen leyéndose con createUserScopedClient()
// (api/_lib/auth.ts) y RLS normal — este cliente no se usa para eso, para
// no convertirlo en un atajo que esquive el aislamiento por usuario.
export function createAdminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient;

  const url = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error("Falta configurar SUPABASE_SERVICE_ROLE_KEY del lado servidor.");
    throw new AdminConfigError("El servidor no está configurado correctamente. Intentá más tarde.");
  }

  cachedAdminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdminClient;
}
