import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export interface FamilyContact {
  id: string;
  user_id: string;
  nombre: string;
  email: string;
  created_at: string;
}

export class ContactsError extends Error {}

// Límites definidos en supabase/migrations/20260816033400_family_contacts.sql
// (constraints family_contacts_nombre_not_blank / _email_not_blank). Se
// exportan para que el frontend valide lo mismo antes de llamar a Supabase,
// sin duplicar los números "a ciegas".
export const MAX_NOMBRE_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 320;

// Traduce errores de Postgres/Supabase a español simple. 23505 = unique
// violation (email duplicado), 23514 = check violation — ya validados en el
// cliente antes de llegar acá, pero la base de datos es la última barrera.
// Recibe los valores que se intentaron guardar para poder distinguir "vacío"
// de "demasiado largo" dentro de un mismo constraint combinado.
function translateContactsError(error: PostgrestError, attempted: { nombre: string; email: string }): string {
  if (error.code === "23505") {
    return "Ya tenés un contacto guardado con ese email.";
  }
  if (error.code === "23514") {
    if (error.message.includes("family_contacts_email_format")) {
      return "El email no tiene un formato válido.";
    }
    if (error.message.includes("family_contacts_nombre_not_blank")) {
      return attempted.nombre.length > MAX_NOMBRE_LENGTH
        ? `El nombre es demasiado largo (máximo ${MAX_NOMBRE_LENGTH} caracteres).`
        : "El nombre no puede estar vacío.";
    }
    if (error.message.includes("family_contacts_email_not_blank")) {
      return attempted.email.length > MAX_EMAIL_LENGTH
        ? `El email es demasiado largo (máximo ${MAX_EMAIL_LENGTH} caracteres).`
        : "El email no puede estar vacío.";
    }
    return "El nombre y el email no pueden estar vacíos.";
  }
  return "No se pudo completar la operación. Probá de nuevo en unos segundos.";
}

export async function listContacts(): Promise<FamilyContact[]> {
  const { data, error } = await supabase
    .from("family_contacts")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new ContactsError(translateContactsError(error, { nombre: "", email: "" }));
  return data ?? [];
}

export async function addContact(userId: string, nombre: string, email: string): Promise<FamilyContact> {
  const trimmedNombre = nombre.trim();
  const trimmedEmail = email.trim().toLowerCase();

  const { data, error } = await supabase
    .from("family_contacts")
    .insert({ user_id: userId, nombre: trimmedNombre, email: trimmedEmail })
    .select()
    .single();

  if (error) throw new ContactsError(translateContactsError(error, { nombre: trimmedNombre, email: trimmedEmail }));
  return data;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("family_contacts").delete().eq("id", id);
  if (error) throw new ContactsError(translateContactsError(error, { nombre: "", email: "" }));
}
