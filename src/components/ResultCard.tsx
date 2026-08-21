import type { ClassifierResult, RiskLevel } from "../../shared/classifierContract";

// Día 8B: cada nivel distingue por texto + icono + grosor de borde, no solo
// por color — así se entiende igual en escala de grises o para daltonismo.
const RISK_STYLES: Record<RiskLevel, { label: string; icon: string; container: string; badge: string }> = {
  bajo: {
    label: "Riesgo bajo",
    icon: "✅",
    container: "border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950",
    badge: "bg-green-600 text-white",
  },
  medio: {
    label: "Riesgo medio",
    icon: "⚠️",
    container: "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950 border-l-[10px]",
    badge: "bg-amber-500 text-white",
  },
  alto: {
    label: "Riesgo alto",
    icon: "🚨",
    container: "border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950 border-l-[10px]",
    badge: "bg-red-600 text-white",
  },
};

export function ResultCard({ result }: { result: ClassifierResult }) {
  const style = RISK_STYLES[result.risk_level];

  return (
    <section
      role="status"
      aria-live="polite"
      className={`mt-6 rounded-2xl border-2 p-5 sm:p-6 ${style.container}`}
    >
      <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-base font-bold ${style.badge}`}>
        <span aria-hidden="true">{style.icon}</span>
        {style.label}
      </span>

      {result.signals.length > 0 && (
        <div className="mt-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Señales detectadas</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-base text-gray-800 dark:text-gray-200">
            {result.signals.map((signal, i) => (
              <li key={i}>{signal}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">¿Qué significa?</h2>
        <p className="mt-2 text-base text-gray-800 dark:text-gray-200">{result.explanation}</p>
      </div>

      <div className="mt-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Qué hacer ahora</h2>
        <p className="mt-2 text-base text-gray-800 dark:text-gray-200">{result.recommended_action}</p>
      </div>
    </section>
  );
}
