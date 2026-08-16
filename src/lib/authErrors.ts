// Traduce los mensajes más comunes que devuelve Supabase Auth a español
// simple. Si no reconoce el mensaje, devuelve uno genérico — nunca expone
// el texto crudo de Supabase (podría ser técnico o en inglés).
export function translateAuthError(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid login credentials")) {
    return "Email o contraseña incorrectos.";
  }
  if (normalized.includes("user already registered") || normalized.includes("already registered")) {
    return "Ya existe una cuenta con ese email. Probá iniciar sesión.";
  }
  if (normalized.includes("password should be at least") || normalized.includes("password is too short")) {
    return "La contraseña es demasiado corta.";
  }
  if (normalized.includes("unable to validate email address") || normalized.includes("invalid email")) {
    return "El email no tiene un formato válido.";
  }
  if (normalized.includes("email not confirmed")) {
    return "Todavía no confirmaste tu email. Revisá tu correo antes de ingresar.";
  }
  if (normalized.includes("email rate limit") || normalized.includes("over_email_send_rate_limit")) {
    return "Se enviaron demasiados emails de confirmación en poco tiempo. Esperá unos minutos y volvé a intentar.";
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return "Se hicieron demasiados intentos. Esperá unos segundos y volvé a intentar.";
  }

  return "No se pudo completar la operación. Probá de nuevo en unos segundos.";
}
