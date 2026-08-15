import type { ClassifierResult, RiskLevel } from "../../shared/classifierContract";

const RISK_STYLES: Record<RiskLevel, { label: string; container: string; badge: string }> = {
  bajo: {
    label: "Riesgo bajo",
    container: "border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950",
    badge: "bg-green-600 text-white",
  },
  medio: {
    label: "Riesgo medio",
    container: "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950",
    badge: "bg-amber-500 text-white",
  },
  alto: {
    label: "Riesgo alto",
    container: "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950",
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
      <span className={`inline-block rounded-full px-4 py-1.5 text-base font-bold ${style.badge}`}>
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
