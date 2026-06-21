import type { CategoryTranslation } from "./categories";

/**
 * Spanish (es) translations for the category landers (#280), keyed by slug. The
 * canonical English lives in `categories.ts`; this file overlays its prose at
 * lookup time (see `getCategory`). Product vocabulary follows the app's own es
 * catalog: rúbrica, ejecución de evaluación, programación, ejecución de
 * optimización, equipo, sistema. "Baseline" is the brand and stays untranslated.
 *
 * Machine-drafted, pending native-speaker review before the locale set widens in
 * production (the editorial gate ADR-0013 calls for).
 */
export const CATEGORIES_ES: Record<string, CategoryTranslation> = {
  "llm-evaluation": {
    metaTitle: "Evaluación de LLM: mide y mejora la calidad de la IA | Baseline",
    metaDescription:
      "La evaluación de LLM es la forma en que los equipos comprueban si su IA es lo bastante buena para lanzarla, y la mantienen así. Baseline convierte la evaluación en rúbricas, ejecuciones programadas y optimización automática, sin necesidad de un equipo de ciencia de datos.",
    heading: "Evaluación de LLM que todo tu equipo puede ejecutar de verdad",
    ogSubtitle: "Mide la calidad de la IA. Mantenla subiendo.",
    intro:
      "La evaluación de LLM es la forma de saber si tu IA es lo bastante buena para ponerla ante tus clientes, antes de que ellos te digan que no lo es. Baseline la hace medible y repetible. Defines una vez qué significa que algo esté bien, puntúas cada resultado según esa definición y dejas que el sistema detecte las regresiones y mejore por su cuenta los prompts más débiles.",
    explainer: [
      "Los grandes modelos de lenguaje no son deterministas. El mismo prompt puede devolver una respuesta excelente hoy y otra confusa mañana. Sin evaluación, lanzas a ojo: alguien echa un vistazo a unos cuantos resultados, dice que están «bastante bien» y la calidad se deteriora en cuanto cambia un prompt, un modelo o un proveedor por debajo.",
      "La evaluación de LLM sustituye la prueba a ojo por una medición. Decides cómo es un buen resultado, lo conviertes en criterios y puntúas los resultados según esos criterios de forma coherente. «¿Funciona nuestra IA?» deja de ser una opinión y se convierte en un número que puedes seguir a lo largo del tiempo y entre versiones.",
      "Bien hecha, la evaluación no es una auditoría puntual. Se ejecuta de forma continua, marca las regresiones antes de que las sufran los clientes y alimenta directamente la mejora del producto. Ese ciclo es justo lo que sustenta Baseline.",
    ],
    howBaseline: [
      {
        feature: "Rúbricas",
        body: "Escribe cómo es un buen resultado en forma de criterios ponderados y en lenguaje claro, sin ningún cuaderno ni framework de evaluación que aprender. Cada ejecución de evaluación puntúa según esa única definición compartida.",
      },
      {
        feature: "Ejecuciones de evaluación",
        body: "Puntúa un lote de resultados de IA según una rúbrica y obtén un único número general que todo el equipo entiende, además del desglose por criterio que lo explica.",
      },
      {
        feature: "Programaciones",
        body: "Pon la evaluación en piloto automático. Una programación vuelve a ejecutar una rúbrica contra tu sistema en producción con la cadencia que elijas, así una regresión aparece en un panel en lugar de en un ticket de soporte.",
      },
      {
        feature: "Ejecuciones de optimización",
        body: "Cuando la calidad baja, entrega la rúbrica a una ejecución de optimización que busca mejores prompts y demuestra la mejora frente a los mismos criterios.",
      },
    ],
    outcomes: [
      "Cambia el «a mí me parece bien» por una puntuación de calidad en la que confía todo tu equipo.",
      "Detecta las regresiones automáticamente cuando cambia un modelo, un prompt o un proveedor.",
      "Da a los compañeros sin perfil técnico una forma de juzgar la calidad de la IA sin leer código.",
      "Convierte cada evaluación en un punto de partida para mejorar el producto.",
    ],
    faqs: [
      {
        question: "¿Necesito un equipo de ciencia de datos para evaluar un LLM?",
        answer:
          "No. Baseline está pensado para que un product manager o un experto del dominio cree una rúbrica en el navegador y lea los resultados. Evaluar es una actividad de equipo, no de especialistas.",
      },
      {
        question: "¿En qué se diferencia de probar prompts a mano?",
        answer:
          "Probar a mano comprueba unos pocos resultados una vez y los olvida. La evaluación puntúa cada resultado según una definición fija de calidad, se ejecuta de forma programada y sigue la tendencia, así detectas la deriva en lugar de redescubrirla.",
      },
      {
        question: "¿Puedo empezar gratis?",
        answer:
          "Sí. Baseline tiene un plan gratuito sin tarjeta de crédito. Crea una rúbrica y lanza tu primera evaluación en el navegador.",
      },
    ],
  },
  "llm-as-judge": {
    metaTitle: "LLM como juez: puntuación automática en la que confiar | Baseline",
    metaDescription:
      "El LLM como juez usa un modelo de IA para calificar los resultados de otro a gran escala. Baseline hace que ese juicio sea coherente y legible, calificado según una rúbrica que todo tu equipo acuerda en lugar de una caja negra.",
    heading: "El LLM como juez, hecho coherente y revisable",
    ogSubtitle: "Calificación automática en la que sí puedes confiar.",
    intro:
      "El LLM como juez es la forma de calificar miles de resultados de IA sin miles de horas de revisión humana. Le pides a un modelo capaz que puntúe el trabajo según tus criterios. El reto es la confianza, porque un evaluador sin fundamento es solo otra opinión. Baseline ancla al juez a una rúbrica que escribió tu equipo, de modo que las puntuaciones son coherentes, explicables y revisables.",
    explainer: [
      "La revisión humana es el estándar de oro para juzgar la calidad de la IA, y no escala. Revisar cada resultado a mano es lento, caro e inconsistente entre revisores, así que la mayoría de los equipos comprueban una muestra mínima y esperan que sea representativa.",
      "El LLM como juez cierra esa brecha. Un modelo potente lee cada resultado y lo puntúa según tus criterios, igual que haría un revisor con experiencia, pero en segundos y a cualquier volumen. El riesgo es que un juez sin restricciones resulta opaco: obtienes un número sin saber por qué, y no hay dos ejecuciones que coincidan.",
      "La solución es el fundamento. Cuando el juez puntúa según una rúbrica explícita y ponderada en lugar de un vago «¿esto está bien?», sus juicios se vuelven coherentes y auditables. Puedes ver qué criterio provocó una puntuación baja y comprobar tú mismo la decisión. Esa es la diferencia entre un evaluador útil y una caja negra.",
    ],
    howBaseline: [
      {
        feature: "Juicio anclado a la rúbrica",
        body: "El juez puntúa según los mismos criterios ponderados que escribió tu equipo, no un estándar interno invisible, así que cada puntuación remite a un criterio que puedes leer.",
      },
      {
        feature: "Desglose por criterio",
        body: "Cada ejecución de evaluación muestra cómo puntuó el juez cada criterio, de modo que un número general bajo viene con su motivo. Sin adivinar por qué falló un resultado.",
      },
      {
        feature: "Ejecuciones coherentes",
        body: "Como la rúbrica es fija, los mismos resultados se califican igual entre ejecuciones. Mides la IA, no el ánimo del evaluador.",
      },
      {
        feature: "Con la persona en el bucle",
        body: "Revisa por muestreo las decisiones del juez y mantén la rúbrica honesta. La puntuación automática se ocupa del volumen y tu equipo conserva la última palabra.",
      },
    ],
    outcomes: [
      "Califica miles de resultados sin miles de horas de revisión.",
      "Obtén puntuaciones que vienen con motivos, no solo un número.",
      "Mantén la calificación coherente entre ejecuciones porque los criterios no se mueven.",
      "Audita y corrige al juez siempre que lo necesites.",
    ],
    faqs: [
      {
        question: "¿De verdad se puede confiar en que un LLM califique a otro LLM?",
        answer:
          "Sí, cuando el juez está anclado a una rúbrica explícita y su razonamiento por criterio queda a la vista para revisarlo. Baseline se construye sobre ese fundamento, y siempre puedes revisar por muestreo o corregir una decisión.",
      },
      {
        question: "¿No serán distintas las puntuaciones cada vez?",
        answer:
          "La deriva viene de instrucciones vagas. Puntuar según criterios fijos y ponderados hace que las ejecuciones sean comparables, así que un cambio de puntuación refleja que cambió la IA, no el evaluador.",
      },
      {
        question: "¿El LLM como juez sustituye a la revisión humana?",
        answer:
          "Es un multiplicador de fuerza. El juez se ocupa del volumen, mientras tu equipo fija los criterios y conserva la última palabra en las decisiones que importan.",
      },
    ],
  },
  "prompt-optimization": {
    metaTitle: "Optimización de prompts: deja de ajustar a mano | Baseline",
    metaDescription:
      "Optimizar prompts significa encontrar de forma sistemática prompts que puntúan más alto, en lugar de retocar a mano y cruzar los dedos. Baseline hace la búsqueda por ti y demuestra la mejora frente a tu rúbrica.",
    heading: "Optimización de prompts sin conjeturas",
    ogSubtitle: "Mejores prompts, encontrados y demostrados por ti.",
    intro:
      "La optimización de prompts es la forma de conseguir un prompt notablemente mejor sin pasar una semana retocando palabras y cruzando los dedos. Baseline la trata como una búsqueda. Genera y prueba variaciones de prompt, puntúa cada una según tu rúbrica y te devuelve la versión que gana de forma medible, con la prueba adjunta.",
    explainer: [
      "La mayoría de los equipos mejoran los prompts a mano: cambian una frase, prueban unos ejemplos, deciden que suena mejor y lo lanzan. Es lento, no escala más allá de un par de prompts, y «suena mejor» es justo ese juicio sin medir que la evaluación existe para sustituir.",
      "La optimización de prompts hace sistemática la mejora. El sistema explora muchos prompts candidatos, puntúa cada uno según los mismos criterios y se queda con lo que de verdad rinde. Convierte la ingeniería de prompts de la intuición de una persona en una búsqueda medida.",
      "Una puntuación mejor vale más cuando puedes defenderla. Cuando un prompt nuevo supera la rúbrica que tu equipo acordó, puedes lanzarlo sabiendo que la mejora es real y enseñar ese número a quien lo pregunte.",
    ],
    howBaseline: [
      {
        feature: "Ejecuciones de optimización",
        body: "Apunta una ejecución al prompt que quieres mejorar y busca variaciones más fuertes de forma automática, en lugar de que edites y vuelvas a probar a mano.",
      },
      {
        feature: "Puntuado según tu rúbrica",
        body: "Cada candidato se califica según los mismos criterios con los que evalúas, así que un ganador es el que supera tu definición real de calidad, no otro benchmark.",
      },
      {
        feature: "Mejora demostrada",
        body: "La ejecución informa de la puntuación antes y después frente a esa rúbrica, de modo que la mejora es un número que puedes enseñar, no una corazonada.",
      },
      {
        feature: "Cierra el ciclo",
        body: "La misma rúbrica que detectó la regresión impulsa la corrección. Evaluación y mejora son un solo flujo de trabajo, no dos herramientas desconectadas.",
      },
    ],
    outcomes: [
      "Deja de dedicar tiempo de ingeniería a ajustar prompts a mano.",
      "Mejora prompts que tus expertos sin perfil técnico no pueden editar pero sí evaluar.",
      "Lanza cambios de prompt con la prueba de la mejora, no con una intuición.",
      "Convierte una evaluación fallida directamente en un prompt mejor.",
    ],
    faqs: [
      {
        question: "¿En qué se diferencia de un playground de prompts?",
        answer:
          "Un playground te deja probar prompts de uno en uno y juzgar a ojo. La optimización busca muchos candidatos por ti y puntúa cada uno según tu rúbrica, así que el ganador se mide, no se elige por corazonada.",
      },
      {
        question: "¿Tengo que confiar a ciegas en el nuevo prompt?",
        answer:
          "No. Cada ejecución de optimización informa de la puntuación antes y después frente a la misma rúbrica con la que evalúas, así lanzas el cambio sabiendo exactamente cuánto ayudó.",
      },
      {
        question: "¿Quién puede lanzar una optimización?",
        answer:
          "Cualquiera que sepa leer resultados. La persona experta que es dueña de la rúbrica inicia una ejecución y revisa la mejora demostrada, sin necesidad de experiencia en ingeniería de prompts.",
      },
    ],
  },
  "rubric-based-evaluation": {
    metaTitle:
      "Evaluación basada en rúbricas: define la calidad una vez | Baseline",
    metaDescription:
      "La evaluación basada en rúbricas convierte una idea difusa de «buen resultado» en criterios explícitos y ponderados que todo tu equipo acuerda. Baseline hace de la rúbrica la definición compartida y reutilizable contra la que se ejecuta cada evaluación y optimización.",
    heading: "Evaluación basada en rúbricas: una sola definición de calidad",
    ogSubtitle: "Define la calidad una vez. Reutilízala en todo.",
    intro:
      "La evaluación basada en rúbricas es la forma de que «buen resultado» signifique lo mismo para todos, para que la calidad deje de vivir en la cabeza de cada revisor. Lo escribes una vez como criterios ponderados, y esa rúbrica se convierte en la única definición contra la que miden cada ejecución de evaluación, programación y ejecución de optimización.",
    explainer: [
      "Pregunta a tres personas si una respuesta de IA es «buena» y obtendrás tres respuestas. A una le importa la exactitud, a otra el tono, a otra la longitud. Ese desacuerdo permanece invisible hasta que se lanza como calidad inconsistente, y por eso las puntuaciones que nadie definió son puntuaciones en las que nadie confía.",
      "Una rúbrica hace explícito el estándar. Divides «bueno» en criterios con nombre y los ponderas según lo que de verdad importa para tu producto. Ahora todos, y cada evaluador automático, puntúan según lo mismo. El juicio difuso se convierte en un artefacto compartido y escrito del que tu equipo es dueño.",
      "Como la rúbrica es un único objeto reutilizable, une todo el flujo de trabajo. Los mismos criterios que definen una ejecución de evaluación aprobada impulsan las comprobaciones programadas y la optimización que corrige las regresiones. Cambia la definición de calidad en un sitio y todo lo demás la sigue.",
    ],
    howBaseline: [
      {
        feature: "Criterios ponderados",
        body: "Redacta los criterios que definen un buen resultado y pondéralos por importancia, para que la puntuación general refleje lo que de verdad importa a tu producto.",
      },
      {
        feature: "Creadas en la interfaz",
        body: "Crea y edita rúbricas en el navegador y en lenguaje claro. El experto del dominio que sabe cómo es lo bueno es dueño de la definición, sin necesidad de código.",
      },
      {
        feature: "Una definición compartida",
        body: "Todo el equipo puntúa según la misma rúbrica, y los miembros de solo lectura pueden ver los resultados sin cambiar los criterios, así que el estándar se mantiene estable.",
      },
      {
        feature: "Reutilizada en todo el flujo",
        body: "La misma rúbrica impulsa ejecuciones de evaluación puntuales, programaciones periódicas y ejecuciones de optimización. Define la calidad una vez y reutilízala en todo.",
      },
    ],
    outcomes: [
      "Consigue que cada revisor puntúe según la misma definición de calidad.",
      "Convierte la calidad en un artefacto explícito y escrito en lugar de conocimiento tribal.",
      "Deja que los expertos del dominio sean dueños de los criterios sin tocar código.",
      "Reutiliza una sola rúbrica en evaluación, monitorización y optimización.",
    ],
    faqs: [
      {
        question: "¿Qué es exactamente una rúbrica aquí?",
        answer:
          "Un conjunto de criterios ponderados que definen un buen resultado, redactados en lenguaje claro en el navegador. Es el estándar único y compartido contra el que puntúa cada evaluación, programación y optimización.",
      },
      {
        question: "¿Quién escribe la rúbrica?",
        answer:
          "La persona que sabe cómo es lo bueno, normalmente un experto del dominio o responsable de producto más que un ingeniero. Baseline está pensado para que la cree y edite directamente en la interfaz.",
      },
      {
        question: "¿Puedo cambiar los criterios más adelante?",
        answer:
          "Sí. Edita la rúbrica, y cada ejecución de evaluación, programación y ejecución de optimización que la referencia medirá según la definición actualizada. Un cambio, aplicado en todas partes.",
      },
    ],
  },
  "reduce-ai-hallucinations": {
    metaTitle:
      "Reduce las alucinaciones de IA: detéctalas antes que tus clientes | Baseline",
    metaDescription:
      "Las alucinaciones son respuestas seguras pero falsas. Baseline te ayuda a medir con qué frecuencia tu IA se inventa cosas, detectar las nuevas de forma programada y bajar la tasa con rúbricas pensadas para la exactitud.",
    heading: "Reduce las alucinaciones de IA antes de que lleguen a tus clientes",
    ogSubtitle: "Detecta las respuestas inventadas antes que tus clientes.",
    intro:
      "Una alucinación es una respuesta que tu IA da con seguridad y que simplemente no es cierta. No puedes impedir que un modelo cometa alguna, pero sí puedes medir con qué frecuencia ocurre, detectar las nuevas antes de lanzarlas y bajar la tasa de forma constante. Baseline te da la rúbrica, las comprobaciones programadas y el ciclo de optimización para hacer justo eso.",
    explainer: [
      "Las alucinaciones son peligrosas porque son seguras. El modelo no marca la respuesta como una suposición, así que un precio equivocado, una política inventada o una cita falsa se leen exactamente igual que una respuesta correcta. Cuando un cliente se da cuenta, el daño ya está hecho.",
      "Reduces las alucinaciones como arreglas cualquier problema de calidad que no puedes ver: lo haces medible. Define cómo es una respuesta fundamentada y exacta, puntúa resultados reales según esa definición, y «¿con qué frecuencia se inventa cosas nuestra IA?» se convierte en un número que puedes vigilar en lugar de una sensación que discutir.",
      "Una vez medida la tasa, puedes actuar sobre ella. Las comprobaciones programadas detectan un nuevo repunte el día en que cambia un prompt o un modelo, y una pasada de optimización reescribe los prompts que producen más fallos. El número baja, y puedes demostrarlo.",
    ],
    howBaseline: [
      {
        feature: "Rúbricas centradas en la exactitud",
        body: "Redacta criterios que premian las respuestas fundamentadas y verificables y penalizan los hechos inventados, para que cada ejecución de evaluación puntúe cuán veraz es tu IA, no solo cuán fluida suena.",
      },
      {
        feature: "Una tasa de alucinación medida",
        body: "Cada ejecución de evaluación convierte un lote de resultados en una puntuación legible, así puedes ver con qué frecuencia se desvía tu IA y seguir ese número versión tras versión.",
      },
      {
        feature: "Comprobaciones programadas de regresión",
        body: "Una programación vuelve a ejecutar la rúbrica contra tu sistema en producción con la cadencia que elijas, así un aumento de respuestas inventadas aparece en un panel el mismo día que empieza, no en la queja de un cliente.",
      },
      {
        feature: "Optimización que ataca los fallos",
        body: "Entrega la rúbrica a una ejecución de optimización y buscará prompts que mantengan el listón de la exactitud, y luego demuestra la bajada frente a la misma puntuación.",
      },
    ],
    outcomes: [
      "Pon un número real a la frecuencia con que tu IA se inventa cosas.",
      "Detecta un nuevo repunte de alucinaciones el día en que cambia un prompt o un modelo.",
      "Premia las respuestas fundamentadas con rúbricas que todo tu equipo puede leer.",
      "Demuestra la mejora de exactitud, no solo la afirmes.",
    ],
    faqs: [
      {
        question: "¿De verdad se puede impedir que un LLM alucine?",
        answer:
          "No del todo, y quien promete cero está exagerando. Lo que sí puedes hacer es medir la tasa, detectar pronto las regresiones y bajarla con mejores prompts y fundamento. Baseline está pensado para ese ciclo.",
      },
      {
        question: "¿Cómo se mide algo tan difuso como una alucinación?",
        answer:
          "Defines cómo es una respuesta fundamentada y exacta en forma de criterios de rúbrica, y luego puntúas los resultados según ella. La preocupación difusa se convierte en un número que puedes seguir en el tiempo.",
      },
      {
        question: "¿Necesito ingenieros para configurar esto?",
        answer:
          "No. Un experto del dominio que sabe cómo es una respuesta correcta puede crear la rúbrica en el navegador y leer los resultados. Detectar alucinaciones es un esfuerzo de equipo, no de especialistas.",
      },
    ],
  },
  "ai-agent-testing": {
    metaTitle:
      "Pruebas de agentes de IA: evalúa agentes de forma programada | Baseline",
    metaDescription:
      "Los agentes de IA son difíciles de probar porque actúan, no solo responden. Baseline se conecta a tu agente, puntúa sus resultados reales según una rúbrica y repite la comprobación de forma programada para que las regresiones salgan pronto a la luz.",
    heading: "Pruebas de agentes de IA que siguen el ritmo de un objetivo en movimiento",
    ogSubtitle: "Prueba tu agente con su comportamiento real, de forma programada.",
    intro:
      "Un agente de IA no solo responde a una pregunta. Da pasos, llama a herramientas y toma decisiones. Eso lo hace potente y difícil de probar, porque lo que estás comprobando cambia sin parar a medida que ajustas prompts, cambias de modelo o añades herramientas. Baseline se conecta a tu agente, puntúa sus resultados reales según una rúbrica y repite esa comprobación con una programación para que detectes una regresión cuando todavía es barata de arreglar.",
    explainer: [
      "Probar un agente con unos cuantos prompts manuales te dice que funcionó una vez, en los casos que se te ocurrió probar. Los agentes fallan en los casos que no probaste: una herramienta devuelve algo inesperado, un plan de varios pasos se tuerce, una actualización del modelo cambia un comportamiento del que dependías.",
      "Probar de verdad un agente comprueba el comportamiento, no una sola instantánea. Conectas Baseline al agente en marcha, le envías un lote de entradas representativas y puntúas los resultados reales según los criterios que definiste. «¿Sigue haciendo su trabajo el agente?» se convierte en una medición que puedes repetir.",
      "Los agentes se desvían a medida que todo a su alrededor cambia, así que una prueba puntual caduca rápido. Una comprobación programada sigue probando con la cadencia que elijas, así el día en que un cambio de herramienta o de modelo rompe algo, lo ves en un panel en lugar de oírlo de un usuario.",
    ],
    howBaseline: [
      {
        feature: "Conexiones de agente",
        body: "Conecta Baseline a tu agente en producción como una conexión de agente, para que las pruebas se ejecuten contra lo real produciendo resultados reales, no una transcripción caduca.",
      },
      {
        feature: "Comportamiento puntuado por rúbrica",
        body: "Puntúa los resultados reales del agente según una rúbrica que escribió tu equipo, así una ejecución aprobada significa que cumplió tu definición de hacer el trabajo, no solo que devolvió algo.",
      },
      {
        feature: "Ejecuciones de prueba programadas",
        body: "Una programación vuelve a ejecutar la evaluación con la cadencia que elijas, así las regresiones de un nuevo prompt, modelo o herramienta salen a la luz en horas en lugar de cuando las sufre un cliente.",
      },
      {
        feature: "De prueba fallida a corrección",
        body: "Cuando una ejecución falla, la misma rúbrica impulsa una ejecución de optimización que busca prompts con los que el agente rinde mejor, y demuestra la recuperación frente a la misma puntuación.",
      },
    ],
    outcomes: [
      "Prueba tu agente con su comportamiento real, no con un puñado de prompts manuales.",
      "Detecta automáticamente las regresiones de un cambio de modelo, prompt o herramienta.",
      "Puntúa qué significa «hacer el trabajo» en términos que todo tu equipo acuerda.",
      "Convierte una prueba de agente fallida directamente en un prompt que rinde mejor.",
    ],
    faqs: [
      {
        question:
          "¿En qué se diferencia probar un agente de probar un solo prompt?",
        answer:
          "Un agente da varios pasos y usa herramientas, así que el resultado depende de más de una respuesta. Baseline puntúa el resultado final real del agente según tu rúbrica, y una programación sigue probando a medida que el agente cambia.",
      },
      {
        question: "¿Baseline ejecuta mi agente por mí?",
        answer:
          "Se conecta a tu agente como una conexión de agente y le envía entradas representativas, y luego puntúa lo que devuelve. Mantienes tu agente donde está y Baseline lo mide.",
      },
      {
        question: "¿Qué pasa cuando una prueba detecta una regresión?",
        answer:
          "Ves la bajada en el panel, y la misma rúbrica puede impulsar una ejecución de optimización que busca mejores prompts y demuestra la recuperación frente a la misma puntuación.",
      },
    ],
  },
};
