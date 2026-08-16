// Autenticación compartida por los scripts de evaluación (eval-classifier.mts
// y eval-image-pipeline.mts): ambos necesitan un access token real de
// Supabase para poder llamar a /api/analyze y /api/extract-image, que ahora
// requieren sesión. Las credenciales del usuario de evaluación se leen
// exclusivamente de variables de entorno — nunca hardcodeadas acá.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export async function getEvalAccessToken(): Promise<string> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const email = process.env.EVAL_USER_EMAIL;
  const password = process.env.EVAL_USER_PASSWORD;

  const missing = [
    !supabaseUrl && "VITE_SUPABASE_URL",
    !supabaseAnonKey && "VITE_SUPABASE_ANON_KEY",
    !email && "EVAL_USER_EMAIL",
    !password && "EVAL_USER_PASSWORD",
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    console.error(
      `Faltan variables de entorno para autenticar la evaluación: ${missing.join(", ")}.\n` +
        "Definilas en tu .env (o exportalas en la shell) — ver .env.example. No se imprime ningún valor.",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl!, supabaseAnonKey!);
  const { data, error } = await supabase.auth.signInWithPassword({ email: email!, password: password! });

  if (error || !data.session) {
    console.error("No se pudo iniciar sesión con el usuario de evaluación (credenciales o cuenta inválidas).");
    process.exit(1);
  }

  return data.session.access_token;
}
