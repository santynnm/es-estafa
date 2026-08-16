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

// Traduce errores de Postgres/Supabase a español simple. 23505 = unique
// violation (email duplicado), 23514 = check violation (nombre/email vacío
// o formato inválido) — ambos ya validados en el cliente antes de llegar
// acá, pero la base de datos es la fuente de verdad final.
function translateContactsError(error: PostgrestError): string {
  if (error.code === "23505") {
    return "Ya tenés un contacto guardado con ese email.";
  }
  if (error.code === "23514") {
    if (error.message.includes("email_format")) {
      return "El email no tiene un formato válido.";
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

  if (error) throw new ContactsError(translateContactsError(error));
  return data ?? [];
}

export async function addContact(userId: string, nombre: string, email: string): Promise<FamilyContact> {
  const { data, error } = await supabase
    .from("family_contacts")
    .insert({ user_id: userId, nombre: nombre.trim(), email: email.trim().toLowerCase() })
    .select()
    .single();

  if (error) throw new ContactsError(translateContactsError(error));
  return data;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("family_contacts").delete().eq("id", id);
  if (error) throw new ContactsError(translateContactsError(error));
}
