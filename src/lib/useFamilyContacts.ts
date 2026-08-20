import { useContext } from "react";
import { FamilyContactsContext, type FamilyContactsContextValue } from "./familyContactsContextDef";

export function useFamilyContacts(): FamilyContactsContextValue {
  const ctx = useContext(FamilyContactsContext);
  if (!ctx) throw new Error("useFamilyContacts debe usarse dentro de <FamilyContactsProvider>.");
  return ctx;
}
