import { useCallback, useState, type ReactNode } from "react";
import { useAlertSending } from "./useAlertSending";
import { NavigationContext, type AppSection } from "./navigationContextDef";

// Estado centralizado de navegación principal (corrección previa al Día 9):
// una sola fuente de "sección activa" para toda la app — ni App, ni
// Analyzer, ni FamilyAlert guardan su propio estado de sección. Vive dentro
// de AlertSendingContext.Provider para poder leer alertSending sin que el
// caller tenga que pasarlo como prop.
export function NavigationProvider({ children }: { children: ReactNode }) {
  const { alertSending } = useAlertSending();
  const [activeSection, setActiveSection] = useState<AppSection>("analyze");
  const [contactsFocusRequestToken, setContactsFocusRequestToken] = useState(0);

  const switchSection = useCallback(
    (section: AppSection, options?: { focusPanelHeading?: boolean }) => {
      // Mientras hay un envío de alerta real en vuelo, la navegación queda
      // bloqueada igual que el resto de las mutaciones coordinadas — esta
      // guarda es la que realmente importa (los controles de la UI además
      // quedan disabled, pero un evento sintético directo sobre ellos
      // seguiría llamando a este handler, así que el bloqueo real vive acá).
      if (alertSending) return;
      setActiveSection(section);
      if (options?.focusPanelHeading && section === "contacts") {
        setContactsFocusRequestToken((t) => t + 1);
      }
    },
    [alertSending],
  );

  return (
    <NavigationContext.Provider value={{ activeSection, switchSection, contactsFocusRequestToken }}>
      {children}
    </NavigationContext.Provider>
  );
}
