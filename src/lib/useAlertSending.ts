import { useContext } from "react";
import { AlertSendingContext, type AlertSendingContextValue } from "./alertSendingContextDef";

export function useAlertSending(): AlertSendingContextValue {
  const ctx = useContext(AlertSendingContext);
  if (!ctx) throw new Error("useAlertSending debe usarse dentro de <AlertSendingContext.Provider>.");
  return ctx;
}
