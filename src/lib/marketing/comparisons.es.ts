import type { ComparisonTranslation } from "./comparisons";

/**
 * Spanish (es) translations for the comparison pages (#280), keyed by slug. The
 * canonical English lives in `comparisons.ts`; this file overlays its prose at
 * lookup time (see `getComparison`). Rows keep their `sourceId` so a translated
 * row still resolves to a cited source. Competitor names, `asOf`, and source
 * URLs/labels stay as in the canonical entry. Product vocabulary follows the
 * app's own es catalog (rúbrica, ejecución de evaluación, programación, ejecución
 * de optimización). Machine-drafted, pending native-speaker review.
 */
export const COMPARISONS_ES: Record<string, ComparisonTranslation> = {
  braintrust: {
    metaTitle: "Baseline vs Braintrust: evaluación de LLM comparada",
    metaDescription:
      "Cómo se comparan Baseline y Braintrust para evaluar resultados de IA: puntuación basada en rúbricas, ejecuciones de evaluación programadas y optimización automática de prompts. Verificado, fechado y con fuentes.",
    heading: "Baseline vs Braintrust",
    intro:
      "Tanto Baseline como Braintrust ayudan a los equipos a medir si su IA es lo bastante buena para lanzarla. La diferencia está en lo que haces después: Baseline convierte cada evaluación en una rúbrica que puedes volver a ejecutar con una programación y entregar a una ejecución de optimización que mejora los prompts por ti, así la calidad sigue subiendo sin que un ingeniero esté pendiente.",
    whyBaseline: [
      "Puntúa los resultados de IA según una rúbrica que todo tu equipo puede leer, sin necesidad de cuadernos.",
      "Pon la calidad en piloto automático: una programación vuelve a ejecutar tus evaluaciones y marca las regresiones antes que tus clientes.",
      "Deja que una ejecución de optimización reescriba los prompts débiles por ti, y luego demuestra la mejora frente a la misma rúbrica.",
    ],
    rows: [
      {
        dimension: "Puntuación de resultados de IA basada en rúbricas",
        baseline:
          "Criterios ponderados creados en la interfaz; cada ejecución de evaluación devuelve una puntuación general que todo el equipo puede leer.",
        competitor:
          "Admite evaluadores personalizados y evaluaciones de LLM como juez definidas en código.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Evaluaciones programadas y periódicas",
        baseline:
          "Una programación vuelve a ejecutar una rúbrica con una cadencia contra un sistema conectado y saca a la luz las regresiones automáticamente.",
        competitor:
          "Las evaluaciones se ejecutan desde el SDK o CI; las ejecuciones periódicas las configura el usuario.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Optimización automática de prompts",
        baseline:
          "Una ejecución de optimización busca mejores prompts y demuestra la mejora frente a la misma rúbrica.",
        competitor:
          "Ofrece un playground de prompts y seguimiento de experimentos; la búsqueda de prompts la dirige el usuario.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Para quién está pensado",
        baseline:
          "Compañeros con y sin perfil técnico comparten un mismo espacio de trabajo; los miembros de solo lectura pueden ver los resultados sin editar.",
        competitor:
          "Plataforma centrada en desarrolladores, basada en el SDK y las evaluaciones definidas en código.",
        sourceId: "bt-home",
      },
      {
        dimension: "Cómo empezar",
        baseline:
          "Plan gratuito sin tarjeta de crédito; crea una rúbrica en el navegador.",
        competitor:
          "Hay un plan gratuito; consulta los precios de Braintrust para conocer los límites actuales.",
        sourceId: "bt-pricing",
      },
    ],
  },
  langsmith: {
    metaTitle: "Baseline vs LangSmith: evaluación de LLM comparada",
    metaDescription:
      "Cómo se comparan Baseline y LangSmith para evaluar resultados de IA: puntuación basada en rúbricas, ejecuciones de evaluación programadas y optimización automática de prompts. Verificado, fechado y con fuentes.",
    heading: "Baseline vs LangSmith",
    intro:
      "LangSmith y Baseline ayudan a los equipos a medir si su IA es lo bastante buena para lanzarla. La diferencia está en lo que ocurre después de la puntuación: Baseline convierte cada evaluación en una rúbrica que vuelves a ejecutar con una programación y entregas a una ejecución de optimización que mejora los prompts por ti, así la calidad sigue subiendo sin un ingeniero en el bucle.",
    whyBaseline: [
      "Puntúa los resultados de IA según una rúbrica que todo tu equipo puede leer, sin necesidad de cuadernos.",
      "Pon la calidad en piloto automático: una programación vuelve a ejecutar tus evaluaciones y marca las regresiones antes que tus clientes.",
      "Deja que una ejecución de optimización reescriba los prompts débiles por ti, y luego demuestra la mejora frente a la misma rúbrica.",
    ],
    rows: [
      {
        dimension: "Puntuación de resultados de IA basada en rúbricas",
        baseline:
          "Criterios ponderados creados en la interfaz; cada ejecución de evaluación devuelve una puntuación general que todo el equipo puede leer.",
        competitor:
          "Proporciona evaluadores y puntuación de LLM como juez configurados con el SDK o la interfaz.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Evaluaciones programadas y periódicas",
        baseline:
          "Una programación vuelve a ejecutar una rúbrica con una cadencia contra un sistema conectado y saca a la luz las regresiones automáticamente.",
        competitor:
          "Evalúa trazas y conjuntos de datos registrados desde el SDK o CI; las ejecuciones periódicas las configura el usuario.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Optimización automática de prompts",
        baseline:
          "Una ejecución de optimización busca mejores prompts y demuestra la mejora frente a la misma rúbrica.",
        competitor:
          "Se centra en el rastreo, los conjuntos de datos y los experimentos; la iteración de prompts la dirige el usuario.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Para quién está pensado",
        baseline:
          "Compañeros con y sin perfil técnico comparten un mismo espacio de trabajo; los miembros de solo lectura pueden ver los resultados sin editar.",
        competitor:
          "Enfocada a desarrolladores, muy integrada con el ecosistema de LangChain.",
        sourceId: "ls-home",
      },
      {
        dimension: "Cómo empezar",
        baseline:
          "Plan gratuito sin tarjeta de crédito; crea una rúbrica en el navegador.",
        competitor:
          "Hay un plan gratuito; consulta los precios de LangSmith para conocer los límites actuales.",
        sourceId: "ls-pricing",
      },
    ],
  },
  humanloop: {
    metaTitle: "Baseline vs Humanloop: evaluación de LLM comparada",
    metaDescription:
      "Cómo se comparan Baseline y Humanloop para evaluar resultados de IA: puntuación basada en rúbricas, ejecuciones de evaluación programadas y optimización automática de prompts. Verificado, fechado y con fuentes.",
    heading: "Baseline vs Humanloop",
    intro:
      "Humanloop y Baseline ayudan a los equipos a juzgar y mejorar su IA. La diferencia está en el ciclo: Baseline convierte cada evaluación en una rúbrica que vuelves a ejecutar con una programación y entregas a una ejecución de optimización que reescribe los prompts por ti, así la mejora es automática y no otra tarea más en la lista de alguien.",
    whyBaseline: [
      "Puntúa los resultados de IA según una rúbrica que todo tu equipo puede leer, sin necesidad de cuadernos.",
      "Pon la calidad en piloto automático: una programación vuelve a ejecutar tus evaluaciones y marca las regresiones antes que tus clientes.",
      "Deja que una ejecución de optimización reescriba los prompts débiles por ti, y luego demuestra la mejora frente a la misma rúbrica.",
    ],
    rows: [
      {
        dimension: "Puntuación de resultados de IA basada en rúbricas",
        baseline:
          "Criterios ponderados creados en la interfaz; cada ejecución de evaluación devuelve una puntuación general que todo el equipo puede leer.",
        competitor:
          "Proporciona evaluadores, incluidos humanos y de LLM como juez, gestionados en su interfaz.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Evaluaciones programadas y periódicas",
        baseline:
          "Una programación vuelve a ejecutar una rúbrica con una cadencia contra un sistema conectado y saca a la luz las regresiones automáticamente.",
        competitor:
          "Ejecuta evaluaciones desde el SDK o CI; las ejecuciones periódicas las configura el usuario.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Optimización automática de prompts",
        baseline:
          "Una ejecución de optimización busca mejores prompts y demuestra la mejora frente a la misma rúbrica.",
        competitor:
          "Se centra en la gestión y el versionado de prompts; los cambios de prompt los dirige el autor.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Para quién está pensado",
        baseline:
          "Compañeros con y sin perfil técnico comparten un mismo espacio de trabajo; los miembros de solo lectura pueden ver los resultados sin editar.",
        competitor:
          "Pensada para equipos de producto e ingeniería que colaboran en los prompts.",
        sourceId: "hl-home",
      },
      {
        dimension: "Cómo empezar",
        baseline:
          "Plan gratuito sin tarjeta de crédito; crea una rúbrica en el navegador.",
        competitor:
          "Consulta los precios de Humanloop para ver los planes actuales y los detalles de la prueba.",
        sourceId: "hl-pricing",
      },
    ],
  },
  langfuse: {
    metaTitle: "Baseline vs Langfuse: evaluación de LLM comparada",
    metaDescription:
      "Cómo se comparan Baseline y Langfuse para evaluar resultados de IA: puntuación basada en rúbricas, ejecuciones de evaluación programadas y optimización automática de prompts. Verificado, fechado y con fuentes.",
    heading: "Baseline vs Langfuse",
    intro:
      "Langfuse y Baseline ayudan a los equipos a medir la calidad de la IA. La diferencia está en lo que haces con el resultado: Baseline convierte cada evaluación en una rúbrica que vuelves a ejecutar con una programación y entregas a una ejecución de optimización que mejora los prompts por ti, así la calidad sigue subiendo sin que un ingeniero esté pendiente.",
    whyBaseline: [
      "Puntúa los resultados de IA según una rúbrica que todo tu equipo puede leer, sin necesidad de cuadernos.",
      "Pon la calidad en piloto automático: una programación vuelve a ejecutar tus evaluaciones y marca las regresiones antes que tus clientes.",
      "Deja que una ejecución de optimización reescriba los prompts débiles por ti, y luego demuestra la mejora frente a la misma rúbrica.",
    ],
    rows: [
      {
        dimension: "Puntuación de resultados de IA basada en rúbricas",
        baseline:
          "Criterios ponderados creados en la interfaz; cada ejecución de evaluación devuelve una puntuación general que todo el equipo puede leer.",
        competitor:
          "Registra puntuaciones de LLM como juez y personalizadas sobre las trazas, configuradas por el usuario.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Evaluaciones programadas y periódicas",
        baseline:
          "Una programación vuelve a ejecutar una rúbrica con una cadencia contra un sistema conectado y saca a la luz las regresiones automáticamente.",
        competitor:
          "Admite evaluaciones sobre trazas y conjuntos de datos; la cadencia la configura el usuario.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Optimización automática de prompts",
        baseline:
          "Una ejecución de optimización busca mejores prompts y demuestra la mejora frente a la misma rúbrica.",
        competitor:
          "Se centra en el rastreo, los conjuntos de datos y los experimentos; la iteración de prompts la dirige el usuario.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Para quién está pensado",
        baseline:
          "Compañeros con y sin perfil técnico comparten un mismo espacio de trabajo; los miembros de solo lectura pueden ver los resultados sin editar.",
        competitor:
          "Enfocada a desarrolladores y de código abierto, con autoalojamiento disponible.",
        sourceId: "lf-home",
      },
      {
        dimension: "Cómo empezar",
        baseline:
          "Plan gratuito sin tarjeta de crédito; crea una rúbrica en el navegador.",
        competitor:
          "De código abierto con un plan gratuito en la nube; consulta los precios de Langfuse para conocer los límites actuales.",
        sourceId: "lf-pricing",
      },
    ],
  },
};
