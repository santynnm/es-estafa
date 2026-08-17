import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export class UnauthorizedError extends Error {}
export class AuthConfigError extends Error {}

export interface AuthenticatedUser {
  id: string;
  // Access token ya validado — permite crear un cliente de Supabase "como
  // el usuario" (ver createUserScopedClient) para que las escrituras en
  // checks/alerts_sent sigan pasando por RLS, en vez de una service role key.
  accessToken: string;
}

const UNAUTHORIZED_MESSAGE = "Se requiere una sesión válida para usar esta función.";

function getSupabaseServerConfig(): { url: string; anonKey: string } {
  // Vercel expone todas las env vars configuradas también en runtime de
  // funciones serverless, no solo en build — reutilizamos las mismas
  // VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY que ya usa el frontend, sin
  // necesidad de duplicarlas con otro nombre.
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("Falta configurar VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY del lado servidor.");
    throw new AuthConfigError("El servidor no está configurado correctamente. Intentá más tarde.");
  }
  return { url, anonKey };
}

// Valida el header Authorization: Bearer <access_token> contra Supabase
// Auth, usando la misma URL y anon key públicas que el frontend (nunca la
// service role key). Compartido por api/analyze.ts, api/extract-image.ts y
// api/send-alert.ts para no duplicar esta lógica entre endpoints.
export async function requireAuth(req: VercelRequest): Promise<AuthenticatedUser> {
  const { url, anonKey } = getSupabaseServerConfig();

  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    throw new UnauthorizedError(UNAUTHORIZED_MESSAGE);
  }

  const supabase = createClient(url, anonKey);
  const { data, error } = await supabase.auth.getUser(token);
  // No logueamos `token` ni `error` completo (podría incluir el JWT) — solo
  // el hecho de que falló, sin el secreto.
  if (error || !data.user) {
    throw new UnauthorizedError(UNAUTHORIZED_MESSAGE);
  }

  return { id: data.user.id, accessToken: token };
}

// Cliente de Supabase que actúa "como" el usuario autenticado (su JWT va en
// el header Authorization de cada request a PostgREST), para que RLS siga
// siendo la barrera efectiva en vez de confiar en un user_id enviado por el
// cliente o en una service role key que la ignoraría.
export function createUserScopedClient(accessToken: string): SupabaseClient {
  const { url, anonKey } = getSupabaseServerConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function respondToAuthError(res: VercelResponse, err: unknown): boolean {
  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message });
    return true;
  }
  if (err instanceof AuthConfigError) {
    res.status(500).json({ error: err.message });
    return true;
  }
  return false;
}
