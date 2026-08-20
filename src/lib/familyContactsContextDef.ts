import { createContext } from "react";
import type { FamilyContact } from "./contacts";

export interface FamilyContactsContextValue {
  // null = todavía no se resolvió la primera carga (ver "loading").
  contacts: FamilyContact[] | null;
  loading: boolean;
  error: string | null;
  addContact: (nombre: string, email: string) => Promise<FamilyContact>;
  removeContact: (id: string) => Promise<void>;
  reload: () => void;
}

export const FamilyContactsContext = createContext<FamilyContactsContextValue | undefined>(undefined);
