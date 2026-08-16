import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export class UnauthorizedError extends Error {}
export class AuthConfigError extends Error {}

export interface AuthenticatedUser {
  id: string;
}

const UNAUTHORIZED_MESSAGE = "Se requiere una sesión válida para usar esta función.";

// Valida el header Authorization: Bearer <access_token> contra Supabase
// Auth, usando la misma URL y anon key públicas que el frontend (nunca la
// service role key). Compartido por api/analyze.ts y api/extract-image.ts
// para no duplicar esta lógica entre los dos endpoints.
export async function requireAuth(req: VercelRequest): Promise<AuthenticatedUser> {
  // Vercel expone todas las env vars configuradas también en runtime de
  // funciones serverless, no solo en build — reutilizamos las mismas
  // VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY que ya usa el frontend, sin
  // necesidad de duplicarlas con otro nombre.
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Falta configurar VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY del lado servidor.");
    throw new AuthConfigError("El servidor no está configurado correctamente. Intentá más tarde.");
  }

  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    throw new UnauthorizedError(UNAUTHORIZED_MESSAGE);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await supabase.auth.getUser(token);
  // No logueamos `token` ni `error` completo (podría incluir el JWT) — solo
  // el hecho de que falló, sin el secreto.
  if (error || !data.user) {
    throw new UnauthorizedError(UNAUTHORIZED_MESSAGE);
  }

  return { id: data.user.id };
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
