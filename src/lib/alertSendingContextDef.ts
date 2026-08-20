import { createContext } from "react";

export interface AlertSendingContextValue {
  // true exactamente entre el momento en que FamilyAlert confirma un envío
  // (justo antes de llamar a sendFamilyAlert) y su resolución (éxito o
  // error) — nunca mientras el usuario solo está eligiendo un contacto o
  // viendo la confirmación sin haber apretado "Confirmar envío" todavía.
  // Coordinación acotada entre Analyzer, FamilyAlert, FamilyContacts y el
  // botón de logout (App): mientras es true, ninguno de ellos debe permitir
  // cambiar el análisis en curso, la sesión, ni la lista de contactos.
  alertSending: boolean;
  setAlertSending: (value: boolean) => void;
}

export const AlertSendingContext = createContext<AlertSendingContextValue | undefined>(undefined);
