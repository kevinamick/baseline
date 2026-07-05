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
    walkthrough: [
      {
        title: "Define qué significa un buen resultado",
        body: "Crea una rúbrica: describe el escenario, el resultado esperado y los criterios que importan. El editor guía la estructura, y basta con lenguaje claro.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "El editor de rúbricas de Baseline con la descripción del escenario, el resultado esperado y el modo de evaluación rellenados para una rúbrica de respuestas de soporte.",
        },
      },
      {
        title: "Lanza una evaluación contra resultados reales",
        body: "Inicia una ejecución de evaluación desde la rúbrica: aporta un lote de entradas y las respuestas de tu IA, y Baseline puntúa cada fila según los criterios. Cada ejecución queda en el historial de la rúbrica con su puntuación general.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "El historial de ejecuciones de evaluación de una rúbrica en Baseline, cinco ejecuciones completadas con puntuaciones que suben del 56 % al 82 %.",
        },
      },
      {
        title: "Lee la puntuación y luego los motivos",
        body: "Abre una ejecución para ver el desglose por fila y por criterio. Cada puntuación viene con el razonamiento escrito del juez, así una fila débil te dice exactamente qué arreglar.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "El detalle de una ejecución de evaluación en Baseline con una puntuación general del 82 % y el razonamiento por criterio para exactitud, completitud y tono.",
        },
      },
      {
        title: "Sigue la tendencia y detecta la deriva",
        body: "El panel sigue la puntuación de cada rúbrica a lo largo del tiempo, y una programación mantiene las ejecuciones llegando con una cadencia. Una regresión aparece como una caída en la gráfica el mismo día que ocurre.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "El panel de Baseline con una gráfica de puntuación en el tiempo que sube del 56 % al 82 % y un panel de foco por criterio.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rúbricas",
        body: "Una única definición compartida de calidad, escrita una vez en lenguaje claro y usada por cada ejecución, programación y optimización que viene después.",
      },
      {
        feature: "Ejecuciones de evaluación",
        body: "Un lote de resultados se convierte en una puntuación que todo el equipo puede leer, con el detalle por criterio detrás.",
      },
      {
        feature: "Programaciones",
        body: "Las ejecuciones periódicas contra tu sistema en producción mantienen la medición al día mientras todos siguen centrados en el producto.",
      },
      {
        feature: "Ejecuciones de optimización",
        body: "Cuando la puntuación baja, la misma rúbrica impulsa una búsqueda automática de mejores prompts y demuestra la recuperación.",
      },
    ],
    outcomes: [
      "Cambia el «a mí me parece bien» por una puntuación de calidad en la que confía todo tu equipo.",
      "Detecta las regresiones el mismo día en que cambia un modelo, un prompt o un proveedor.",
      "Da a los compañeros sin perfil técnico una lectura directa de la calidad de la IA.",
      "Convierte cada evaluación en el punto de partida de la siguiente mejora.",
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
    walkthrough: [
      {
        title: "Dale al juez instrucciones escritas",
        body: "Cada criterio lleva pasos de puntuación: instrucciones cortas y ordenadas que el juez sigue de la misma forma cada vez. Las ponderaciones dicen cuánto mueve cada criterio la puntuación general.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Criterios ponderados en el editor de rúbricas de Baseline, cada uno con pasos de puntuación en lenguaje claro para que el juez los siga.",
        },
      },
      {
        title: "El juez puntúa y enseña su trabajo",
        body: "En cada fila de una ejecución de evaluación, el juez puntúa cada criterio y deja por escrito el porqué. El razonamiento va junto al número, así un 0,80 en exactitud viene con la frase que costó los puntos.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Puntuaciones del juez por criterio con razonamiento escrito en el detalle de una ejecución de evaluación de Baseline.",
        },
      },
      {
        title: "El mismo estándar, ejecuciones comparables",
        body: "Como los criterios y los pasos son fijos, las puntuaciones se alinean de una ejecución a otra. El historial se lee como la tendencia de calidad de tu IA, calificada por el mismo estándar cada vez.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "Cinco ejecuciones de evaluación de la misma rúbrica en Baseline, puntuadas con criterios idénticos a lo largo de dos meses.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Juicio anclado a la rúbrica",
        body: "El juez califica según los criterios ponderados que escribió tu equipo, así cada puntuación remite a un estándar que puedes leer y editar.",
      },
      {
        feature: "Pasos de puntuación",
        body: "Cada criterio da al juez pasos explícitos que seguir. La coherencia viene de instrucciones escritas, igual que para un revisor humano con experiencia.",
      },
      {
        feature: "Razonamiento que puedes auditar",
        body: "Cada puntuación por criterio llega con la justificación escrita del juez, lista para revisar por muestreo, cuestionar o usar para afinar la rúbrica.",
      },
      {
        feature: "Tu proveedor, tu clave",
        body: "Trae tu propia clave de Anthropic, OpenAI, Google o Mistral y el juez se ejecuta con ella. Los equipos de pago también pueden apoyarse en la clave gestionada de Baseline.",
      },
    ],
    outcomes: [
      "Califica miles de resultados en minutos, a cualquier volumen.",
      "Ve el motivo detrás de cada puntuación, por criterio y por fila.",
      "Mantén las ejecuciones comparables porque el estándar de calificación no se mueve.",
      "Revisa al juez por muestreo y deja que tu equipo conserve la última palabra.",
    ],
    faqs: [
      {
        question: "¿De verdad se puede confiar en que un LLM califique a otro LLM?",
        answer:
          "Sí, cuando el juez está anclado a una rúbrica explícita y su razonamiento por criterio queda a la vista para revisarlo. Baseline se construye alrededor de ese fundamento, y siempre puedes revisar por muestreo o corregir una decisión.",
      },
      {
        question: "¿No serán distintas las puntuaciones cada vez?",
        answer:
          "La deriva viene de instrucciones vagas. Puntuar según criterios fijos y ponderados y pasos escritos hace que las ejecuciones sean comparables, así que un cambio de puntuación refleja un cambio en tu IA.",
      },
      {
        question: "¿Qué modelo hace de juez?",
        answer:
          "El del proveedor para el que tu equipo tenga una clave: trae una clave de Anthropic, OpenAI, Google o Mistral y el juicio se ejecuta con ella, con tu propio coste de tokens. Los equipos de pago sin clave usan la clave gestionada de Baseline.",
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
    walkthrough: [
      {
        title: "Apunta una ejecución a una rúbrica y un agente",
        body: "Elige la rúbrica que define el éxito, la conexión de agente cuyo prompt quieres mejorar y un presupuesto de pruebas. La ejecución congela de antemano un conjunto de instancias de entrada, así cada candidato se juzga sobre el mismo terreno.",
      },
      {
        title: "Baseline busca, puntúa y se queda con los ganadores",
        body: "La ejecución propone variantes del prompt y prueba cada una contra las entradas congeladas. El modo reflexivo lee los comentarios escritos del juez y reescribe con intención; el modo simple muestrea reescrituras y se queda con las que mejor puntúan.",
      },
      {
        title: "Lanza la mejora, con la prueba adjunta",
        body: "La ejecución informa de las puntuaciones antes y después frente a tu rúbrica y coloca el prompt optimizado junto al de partida para cada módulo. Cópialo cuando estés convencido.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "Una ejecución de optimización completada en Baseline que muestra una mejora de puntuación del 74 % al 86 % y el prompt de partida junto a la versión optimizada.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Ejecuciones de optimización",
        body: "Apunta una ejecución al prompt que quieres mejorar, fija un presupuesto y explorará candidatos mientras tu equipo hace otra cosa.",
      },
      {
        feature: "Dos modos",
        body: "El modo simple muestrea reescrituras puntuadas y se queda con la mejor, ideal para tareas acotadas. El modo reflexivo aprende de los comentarios escritos del juez, pensado para rúbricas exigentes.",
      },
      {
        feature: "Mejora demostrada",
        body: "Cada ejecución informa de las puntuaciones antes y después sobre la misma rúbrica con la que evalúas, así la mejora se mide antes de lanzarla.",
      },
      {
        feature: "Prompts que te llevas contigo",
        body: "Los prompts ganadores quedan junto a sus versiones de partida, por módulo, con copia en un clic. Tu agente, tu prompt, tu decisión.",
      },
    ],
    outcomes: [
      "Recupera las semanas de ingeniería dedicadas a ajustar prompts a mano.",
      "Deja que los expertos del dominio impulsen la calidad de los prompts mediante la rúbrica de la que son dueños.",
      "Lanza cambios de prompt con el número de antes y después adjunto.",
      "Convierte una evaluación fallida directamente en un prompt mejor.",
    ],
    faqs: [
      {
        question: "¿En qué se diferencia de un playground de prompts?",
        answer:
          "Un playground te ayuda a probar prompts de uno en uno y juzgar a ojo. Una ejecución de optimización prueba muchos candidatos por ti y puntúa cada uno según tu rúbrica, así que el ganador es el que rinde de forma medible.",
      },
      {
        question: "¿Cómo sé que el nuevo prompt es realmente mejor?",
        answer:
          "Cada ejecución informa de la puntuación antes y después sobre la misma rúbrica con la que evalúas, y muestra el prompt optimizado junto al de partida, así revisas exactamente qué cambió y qué ganó.",
      },
      {
        question: "¿Qué es un módulo?",
        answer:
          "Un prompt con nombre dentro de tu agente que una ejecución puede mejorar por su cuenta. Una conexión de agente declara sus módulos; una ejecución optimiza uno a la vez e informa de cada prompt por separado.",
      },
      {
        question: "¿Quién puede lanzar una optimización?",
        answer:
          "Cualquiera que sepa leer resultados. La persona experta dueña de la rúbrica inicia una ejecución y revisa la mejora demostrada, sin necesidad de experiencia en ingeniería de prompts.",
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
    walkthrough: [
      {
        title: "Prepara la escena",
        body: "Una rúbrica empieza con una descripción del escenario y un resultado esperado en lenguaje claro: qué se le pide a la IA y qué logra una buena respuesta. El contexto de referencia opcional da al juez material de consulta contra el que comprobar.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "Los campos de descripción del escenario, resultado esperado y contexto de referencia del editor de rúbricas en Baseline.",
        },
      },
      {
        title: "Pondera lo que importa",
        body: "Añade criterios y pondéralos para que la puntuación general refleje tus prioridades. Los pasos de puntuación bajo cada criterio le dicen al juez exactamente cómo calificarlo, con las palabras de tu equipo.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Tres criterios ponderados en el editor de rúbricas de Baseline: exactitud a 0,5, completitud a 0,3 y tono a 0,2, cada uno con pasos de puntuación.",
        },
      },
      {
        title: "Una rúbrica, cada medición",
        body: "La rúbrica terminada impulsa por igual ejecuciones de evaluación puntuales, programaciones periódicas y ejecuciones de optimización. Edita la definición una vez y todo lo que viene después mide según la actualización.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "Una programación de Baseline que ejecuta una rúbrica cada noche contra un agente conectado, con su historial de ejecuciones.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Escenario y resultado esperado",
        body: "La rúbrica captura primero la tarea y el objetivo en prosa, así los criterios tienen contexto y un compañero nuevo puede leer qué significa la calidad aquí.",
      },
      {
        feature: "Criterios ponderados",
        body: "Nombra las dimensiones de la calidad y pondéralas por importancia. Las ponderaciones suman 1, así las prioridades son explícitas y la puntuación general las refleja.",
      },
      {
        feature: "Pasos de puntuación",
        body: "Cada criterio lleva las instrucciones paso a paso que el juez sigue, y convierte una etiqueta como Exactitud en un procedimiento repetible.",
      },
      {
        feature: "Propiedad del equipo",
        body: "Los colaboradores crean y editan en el navegador; los miembros de solo lectura ven cada resultado mientras el estándar se mantiene estable.",
      },
    ],
    outcomes: [
      "Cada revisor, humano o automático, puntúa según un único estándar escrito.",
      "La calidad se convierte en un artefacto explícito y escrito del que el equipo es dueño.",
      "Los expertos del dominio definen la calidad directamente, en el navegador.",
      "Una sola rúbrica impulsa la evaluación, la monitorización y la optimización.",
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
    walkthrough: [
      {
        title: "Redacta criterios que premien las respuestas fundamentadas",
        body: "Da a la exactitud el mayor peso y detalla los pasos de puntuación: comparar con la respuesta esperada, penalizar los hechos inventados. El contexto de referencia entrega al juez el material de consulta contra el que comprobar las afirmaciones.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Una rúbrica centrada en la exactitud en Baseline con pasos de puntuación que penalizan los errores factuales y las omisiones.",
        },
      },
      {
        title: "Puntúa un lote real y ve dónde se desvía",
        body: "Ejecuta una evaluación sobre resultados reales. El desglose por fila muestra qué respuestas fallaron, y el razonamiento del juez nombra la afirmación exacta que costó los puntos.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Razonamiento del juez en una ejecución de evaluación de Baseline que señala un detalle suavizado en una respuesta de soporte por lo demás exacta.",
        },
      },
      {
        title: "Pon la comprobación en una programación",
        body: "Una programación nocturna o cada hora vuelve a puntuar resultados frescos de tu sistema en producción, así un repunte de respuestas inventadas sale a la luz en la siguiente ejecución.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "Una programación nocturna de Baseline que puntúa un agente de soporte en producción, con ejecuciones completadas en su historial.",
        },
      },
      {
        title: "Baja la tasa y demuéstralo",
        body: "El panel muestra la tendencia de exactitud. Cuando baja, una ejecución de optimización busca prompts que mantengan el listón e informa de la recuperación como un número.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "Una tendencia de exactitud al alza en el panel de Baseline tras corregir los prompts.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rúbricas centradas en la exactitud",
        body: "Criterios que premian las respuestas fundamentadas y verificables, ponderados para que la exactitud domine la puntuación general.",
      },
      {
        feature: "Contexto de referencia",
        body: "Adjunta el material de consulta contra el que el juez comprueba las afirmaciones, así «verdadero» significa fiel a tus propios documentos y políticas.",
      },
      {
        feature: "Una tasa medida",
        body: "Cada ejecución convierte un lote en un número, y el razonamiento por fila nombra cada hecho inventado que encontró.",
      },
      {
        feature: "Comprobaciones que no se detienen",
        body: "Las programaciones vuelven a puntuar resultados en producción con una cadencia; un cambio de modelo o de prompt que empieza a fallar aparece en la siguiente ejecución.",
      },
    ],
    outcomes: [
      "Pon un número real a la frecuencia con que tu IA se inventa cosas.",
      "Ve las afirmaciones exactas que fallaron, con el razonamiento del juez.",
      "Detecta un repunte en una sola ejecución programada desde que empieza.",
      "Muestra la mejora de exactitud como una tendencia, con las pruebas en la mano.",
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
        question: "¿Qué hace que una rúbrica sea buena detectando alucinaciones?",
        answer:
          "Tres cosas: un resultado esperado con el que el juez pueda comparar, un contexto de referencia que aporte el material de consulta verdadero y pasos de puntuación que penalicen explícitamente los hechos inventados. El recorrido de arriba prepara las tres.",
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
    walkthrough: [
      {
        title: "Conecta el agente que ejecutas de verdad",
        body: "Una conexión de agente apunta Baseline a tu endpoint en producción: URL, cabecera de autenticación, una plantilla de petición y la ruta de la respuesta hasta la contestación. Las credenciales se cifran en reposo y se descifran solo en el servidor, en el momento en que Baseline llama a tu sistema.",
        image: {
          src: "/docs/schedule-wizard-connection.png",
          alt: "Creación de una conexión de agente en producción en el asistente de programaciones de Baseline, con URL del endpoint, cabecera de autenticación y plantilla del cuerpo de la petición.",
        },
      },
      {
        title: "Ponle nombre a la prueba y elige el estándar",
        body: "El asistente de programaciones te guía por Básicos, Sistema, Entradas, Cadencia, Avisos y Revisión: elige la rúbrica que define el trabajo bien hecho y las entradas que Baseline envía a través del agente.",
        image: {
          src: "/docs/schedule-wizard-step1.png",
          alt: "El primer paso del asistente de programaciones en Baseline, dando nombre a una comprobación nocturna de respuestas de soporte y seleccionando una rúbrica.",
        },
      },
      {
        title: "Deja que la cadencia detecte la deriva",
        body: "En cada ciclo, Baseline invoca al agente con entradas representativas y puntúa los resultados reales. El historial de ejecuciones convierte los cambios de herramientas, de modelo y de prompt en movimientos visibles de la puntuación.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "El historial de ejecuciones de una programación de Baseline para un agente de soporte en producción, con puntuaciones por ejecución y la hora de la próxima.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Conexiones de agente",
        body: "Una definición reutilizable de cómo Baseline llega a tu agente: endpoint, autenticación, plantilla de petición, ruta de la respuesta. Las pruebas se ejecutan contra lo real, en producción.",
      },
      {
        feature: "Credenciales gestionadas en el servidor",
        body: "Los secretos de la conexión se cifran en reposo y en tránsito, y se descifran solo cuando Baseline llama a tu sistema.",
      },
      {
        feature: "Ejecuciones de prueba programadas",
        body: "Una cadencia que eliges, de cada hora a mensual, con avisos de finalización y de fallo para los compañeros a los que les importa.",
      },
      {
        feature: "También fuentes de datos",
        body: "Apunta una conexión de datos a PostHog o a una fuente propia y puntúa el tráfico que tu agente ya produjo, sin ninguna llamada en vivo.",
      },
    ],
    outcomes: [
      "Prueba el comportamiento real del agente con una cadencia, sin mover un dedo.",
      "Detecta en la siguiente ejecución las regresiones de un cambio de modelo, prompt o herramienta.",
      "Define «hacer el trabajo» una vez, en términos que todo el equipo acordó.",
      "Puntúa el tráfico histórico de producción tan fácilmente como las invocaciones en vivo.",
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
        question: "¿Es seguro darle a Baseline las credenciales de la API de mi agente?",
        answer:
          "Los secretos de la conexión se guardan cifrados, nunca se exponen al navegador y se descifran solo en el servidor, en el momento en que Baseline llama a tu endpoint. Puedes rotar o eliminar las credenciales de una conexión en cualquier momento.",
      },
      {
        question: "¿Qué pasa cuando una prueba detecta una regresión?",
        answer:
          "Ves la bajada en el panel, y la misma rúbrica puede impulsar una ejecución de optimización que busca mejores prompts y demuestra la recuperación frente a la misma puntuación.",
      },
    ],
  },
  "simple-mode": {
    metaTitle: "Modo Simple: optimización rápida de prompts para tareas acotadas | Baseline",
    metaDescription:
      "El Modo Simple mejora un prompt pegado probando reescrituras puntuadas y quedándose con la mejor. Aprende cuándo elegirlo frente al Modo Reflexivo, qué hace cada opción de la ejecución y cómo se factura.",
    heading: "Modo Simple: optimización de prompts con menos decisiones",
    ogSubtitle: "Pega un prompt. Quédate con la mejor reescritura.",
    intro:
      "El Modo Simple es la forma más rápida de mejorar un prompt en Baseline. Pega el prompt, añade unas cuantas entradas de prueba, y la ejecución prueba reescritura tras reescritura, puntúa cada una con tu rúbrica sobre las mismas entradas y te devuelve la mejor versión que encontró. Es el modo por defecto al optimizar un prompt pegado, y solo te pide una decisión de verdad: cuántas llamadas puntuadas quieres gastar.",
    explainer: [
      "Una ejecución de optimización en Modo Simple es un torneo de reescrituras. Tu prompt pegado es el primer candidato y se puntúa sobre el conjunto completo de entradas de prueba, llamadas instancias, para fijar la línea base. Cada ronda produce después hasta 8 candidatos nuevos: cada uno parte de uno de los mejores prompts actuales y lo reescribe de una de cinco maneras, como hacerlo más específico, añadir un ejemplo resuelto, reestructurarlo en pasos numerados, condensarlo o replantear su perspectiva.",
      "Cada candidato se puntúa sobre las mismas instancias congeladas con la misma rúbrica, así que las puntuaciones son directamente comparables. Tras cada ronda la ejecución conserva los 3 mejores y reescribe a partir de ellos. Se detiene al agotar el presupuesto de rollouts, al llegar al tope de rondas o tras varias rondas seguidas sin mejora, y termina con el mejor candidato encontrado, con su puntuación junto a la de tu prompt original.",
      "El otro modo de optimización, Reflexivo, lee el razonamiento escrito del juez sobre las puntuaciones recientes y propone prompts informados por ese feedback. Elige Simple para una tarea acotada y bien definida, como un formateador de JSON, un clasificador o un extractor, donde la puntuación ya cuenta toda la historia. Cambia a Reflexivo cuando los criterios de la rúbrica sean matizados, como el tono o los juicios de valor, y el optimizador deba aprender del feedback y no solo de un número.",
    ],
    walkthrough: [
      {
        title: "Elige la rúbrica que define lo que es mejor",
        body: "Cada reescritura se puntúa con una única rúbrica, así que la ejecución optimiza exactamente lo que la rúbrica mide. Elige una existente en el paso Básicos, o escribe una primero si este prompt nunca se ha evaluado.",
      },
      {
        title: "Pega tu prompt y deja Simple seleccionado",
        body: "En el paso Sistema, elige Pegar un prompt, suelta el prompt y escoge el modelo en el que debe ejecutarse: Haiku 4.5 por defecto, o Sonnet 4.6 u Opus 4.8. Simple viene preseleccionado como modo; Reflexivo está a un clic cuando la tarea lo necesite.",
      },
      {
        title: "Añade las entradas de prueba",
        body: "Introduce hasta 50 instancias a mano, o súbelas como CSV o JSON. Solo se requiere la entrada del usuario; la salida esperada y el contexto de recuperación son opcionales. El conjunto se congela al iniciar la ejecución, así que cada candidato se juzga sobre entradas idénticas.",
      },
      {
        title: "Fija el presupuesto y ajusta el resto solo si quieres",
        body: "El presupuesto de rollouts limita las llamadas puntuadas: un rollout es un candidato puntuado sobre una instancia, el valor por defecto es 30 y tu plan fija el máximo por ejecución (200 en Builder, 400 en Scale). Los ajustes avanzados guardan el modelo de reescritura (el modelo rápido por defecto), el tope de rondas (20) y la parada anticipada tras rondas sin mejora (5).",
      },
      {
        title: "Revisa, inicia y recoge al ganador",
        body: "El paso Revisar muestra el modo, el número de instancias, el presupuesto y si la ejecución usa una ejecución de optimización incluida o consume puntos de evaluación. Al completarse obtienes las puntuaciones de antes y después y el prompt optimizado junto al original, listo para copiar.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "Una ejecución de optimización completada en Baseline con una subida de puntuación del 74 % al 86 % y el prompt original junto a la versión optimizada.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rúbricas",
        body: "Tu definición de calidad es la función de aptitud de la ejecución: cada reescritura se puntúa con los mismos criterios que ya usan tus ejecuciones de evaluación.",
      },
      {
        feature: "Agentes gestionados",
        body: "Baseline ejecuta el prompt pegado en un modelo gestionado, así que no hay endpoint que construir ni nada que desplegar antes de poder optimizar.",
      },
      {
        feature: "Ejecuciones de optimización",
        body: "Una ejecución Simple consume de la cuota mensual de ejecuciones de tu plan como cualquier modo, y el presupuesto de rollouts acota su coste antes de empezar.",
      },
      {
        feature: "Modo Reflexivo",
        body: "El mismo asistente ofrece el modo guiado por feedback cuando los criterios de tu rúbrica se vuelven matizados, así que superar Simple es un cambio de un clic.",
      },
    ],
    outcomes: [
      "Mejora un prompt sin conectar un agente ni escribir un endpoint.",
      "Una puntuación medida de antes y después con tu propia rúbrica, sobre las mismas entradas.",
      "Una sola decisión que tomar: el presupuesto. Los valores por defecto se ocupan del resto.",
      "Un camino claro hacia la optimización guiada por feedback cuando la tarea supere la búsqueda solo por puntuación.",
    ],
    faqs: [
      {
        question: "¿Cuándo debería usar el Modo Reflexivo en su lugar?",
        answer:
          "Cuando la rúbrica mide cualidades matizadas, como el tono, la empatía o instrucciones de varias partes que interactúan. Reflexivo lee el razonamiento escrito del juez y propone prompts informados por él. Simple encaja mejor cuando la puntuación por sí sola captura el éxito.",
      },
      {
        question: "¿Cómo dimensiono el presupuesto de rollouts?",
        answer:
          "Cada candidato se puntúa sobre el conjunto completo de instancias, así que un candidato cuesta tantos rollouts como instancias tengas, y la puntuación inicial de tu prompt original también cuenta. Una buena regla es instancias por el número de reescrituras que quieras probar, más una. Con 10 instancias, un presupuesto de 250 cubre la línea base más tres rondas completas de 8 reescrituras.",
      },
      {
        question: "¿Por qué no veo el Modo Simple en mi asistente?",
        answer:
          "El Modo Simple se ofrece para prompts pegados, que se ejecutan como agentes gestionados con la clave de Baseline, una función de los planes de pago. Los agentes conectados por tu propio endpoint se optimizan con el Modo Reflexivo.",
      },
      {
        question: "¿Cuánto cuesta una ejecución?",
        answer:
          "Una ejecución de optimización de la cuota mensual de tu plan (15 en Builder, 75 en Scale); pasada la cuota, una ejecución de pago consume puntos de evaluación por cada rollout puntuado, y el paso Revisar te dice cuál aplica antes de empezar. Los tokens del modelo corren sobre tu propia clave de proveedor si has guardado una, y si no sobre la clave gestionada de Baseline a coste de proveedor más el margen de tu plan, reservado contra tu límite de gasto gestionado.",
      },
      {
        question: "¿Qué pasa si una ejecución alcanza el límite de gasto a mitad?",
        answer:
          "La ejecución falla de inmediato y tu prompt original queda intacto, así que una ejecución cortada nunca presenta en silencio tu prompt sin cambios como un resultado optimizado. Sube el límite o espera al siguiente periodo y vuelve a ejecutar.",
      },
    ],
  },
};
