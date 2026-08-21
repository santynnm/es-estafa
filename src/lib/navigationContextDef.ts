import { createContext } from "react";

export type AppSection = "analyze" | "contacts";

export interface NavigationContextValue {
  activeSection: AppSection;
  // Único punto de cambio de sección para toda la app (nav principal y el
  // CTA de FamilyAlert cuando no hay personas guardadas) — nadie más debe
  // guardar su propio estado de "sección activa". Bloqueada internamente
  // mientras alertSending es true, igual que el resto de las mutaciones
  // coordinadas (ver NavigationProvider); los callers pueden repetir la
  // guarda como defensa en profundidad, pero no es necesario para que el
  // bloqueo funcione.
  //
  // focusPanelHeading: true pide, además de mostrar el panel de contactos,
  // que se mueva el foco (y se haga scroll si hace falta, respetando
  // prefers-reduced-motion) hacia su heading — pensado para el CTA de
  // FamilyAlert que "salta" a otra sección. Un click directo en la pestaña
  // de navegación no lo necesita: el foco ya queda naturalmente en la
  // pestaña, como en cualquier patrón de tabs estándar.
  switchSection: (section: AppSection, options?: { focusPanelHeading?: boolean }) => void;
  // Se incrementa cada vez que switchSection("contacts", { focusPanelHeading:
  // true }) se ejecuta con éxito. FamilyContacts observa este valor (no
  // activeSection en sí) para saber cuándo mover el foco a su heading.
  contactsFocusRequestToken: number;
}

export const NavigationContext = createContext<NavigationContextValue | undefined>(undefined);
