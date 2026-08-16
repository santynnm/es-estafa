import { createClient } from "@supabase/supabase-js";

// Cliente único y reutilizable de Supabase para todo el frontend. Solo usa
// la URL pública y la anon key — nunca la service role key, que no debe
// existir del lado cliente. Si faltan las variables, isSupabaseConfigured
// queda en false y la UI lo muestra en vez de romper el bundle entero.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(supabaseUrl || "https://placeholder.supabase.co", supabaseAnonKey || "placeholder-anon-key");
