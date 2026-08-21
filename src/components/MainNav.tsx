import { useRef, type KeyboardEvent } from "react";
import { useNavigation } from "../lib/useNavigation";
import { useAlertSending } from "../lib/useAlertSending";
import { useFamilyContacts } from "../lib/useFamilyContacts";
import type { AppSection } from "../lib/navigationContextDef";

const SECTIONS: ReadonlyArray<{ id: AppSection; label: string; panelId: string }> = [
  { id: "analyze", label: "Analizar un mensaje", panelId: "panel-analyze" },
  { id: "contacts", label: "Personas de confianza", panelId: "panel-contacts" },
];

// Navegación principal (corrección previa al Día 9): patrón de pestañas
// ARIA con activación automática — mover el foco con las flechas ya cambia
// la sección (estándar recomendado por WAI-ARIA APG para paneles baratos de
// mostrar/ocultar como estos), y Tab/Enter/Espacio funcionan solos por ser
// <button> nativos con roving tabindex. No es sticky ni flotante: vive en el
// flujo normal del documento, inmediatamente debajo de la barra de cuenta.
export function MainNav() {
  const { activeSection, switchSection } = useNavigation();
  const { alertSending } = useAlertSending();
  const { contacts, loading: contactsLoading } = useFamilyContacts();
  const tabRefs = useRef<Partial<Record<AppSection, HTMLButtonElement | null>>>({});

  // null mientras la lista todavía no cargó (o falló) — nunca se muestra un
  // número potencialmente desactualizado o inventado.
  const contactsCount = !contactsLoading && contacts ? contacts.length : null;

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length];
    switchSection(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <nav aria-label="Secciones principales" className="mx-auto max-w-2xl px-4 pt-4 sm:px-6">
      <div role="tablist" aria-label="Secciones principales" className="grid grid-cols-2 gap-2">
        {SECTIONS.map((section, index) => {
          const isActive = activeSection === section.id;
          const label =
            section.id === "contacts" && contactsCount !== null
              ? `${section.label} (${contactsCount})`
              : section.label;

          return (
            <button
              key={section.id}
              ref={(el) => {
                tabRefs.current[section.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${section.id}`}
              aria-selected={isActive}
              aria-controls={section.panelId}
              tabIndex={isActive ? 0 : -1}
              disabled={alertSending}
              aria-disabled={alertSending}
              onClick={() => switchSection(section.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border-2 px-3 py-3 text-center text-base font-semibold leading-snug transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-60 ${
                isActive
                  ? "border-purple-600 bg-purple-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
              }`}
            >
              {isActive && <span aria-hidden="true">✓</span>}
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
