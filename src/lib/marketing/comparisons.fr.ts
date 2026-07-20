import type { ComparisonTranslation } from "./comparisons";

/**
 * French (fr) translations for the comparison pages (#280), keyed by slug. The
 * canonical English lives in `comparisons.ts`; this file overlays its prose at
 * lookup time (see `getComparison`). Rows keep their `sourceId` so a translated
 * row still resolves to a cited source. Competitor names, `asOf`, and source
 * URLs/labels stay as in the canonical entry. Product vocabulary follows the
 * app's own fr catalog (rubrique, exécution d'évaluation, planification, exécution
 * d'optimisation). Machine-drafted, pending native-speaker review.
 */
export const COMPARISONS_FR: Record<string, ComparisonTranslation> = {
  braintrust: {
    metaTitle: "Baseline vs Braintrust : évaluation des LLM comparée",
    metaDescription:
      "Comment Baseline et Braintrust se comparent pour évaluer les sorties d'IA : notation par rubriques, exécutions d'évaluation planifiées et optimisation automatique des prompts. Vérifié, daté et sourcé.",
    heading: "Baseline vs Braintrust",
    intro:
      "Baseline et Braintrust aident tous deux les équipes à mesurer si leur IA est assez bonne pour être lancée. La différence, c'est ce que vous faites ensuite : Baseline transforme chaque évaluation en une rubrique que vous pouvez réexécuter avec une planification et confier à une exécution d'optimisation qui améliore les prompts pour vous, si bien que la qualité continue de progresser sans qu'un ingénieur ait à la surveiller.",
    whyBaseline: [
      "Notez les sorties d'IA selon une rubrique que toute votre équipe peut lire, sans notebook.",
      "Mettez la qualité en pilote automatique : une planification réexécute vos évaluations et signale les régressions avant vos clients.",
      "Laissez une exécution d'optimisation réécrire les prompts faibles pour vous, puis prouvez le gain selon la même rubrique.",
    ],
    rows: [
      {
        dimension: "Notation des sorties d'IA basée sur des rubriques",
        baseline:
          "Critères pondérés créés dans l'interface ; chaque exécution d'évaluation renvoie un score global que toute l'équipe peut lire.",
        competitor:
          "Prend en charge des évaluateurs personnalisés et des évaluations LLM comme juge définies en code.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Évaluations planifiées et récurrentes",
        baseline:
          "Une planification réexécute une rubrique à une cadence donnée sur un système connecté et fait remonter les régressions automatiquement.",
        competitor:
          "Les évaluations sont lancées depuis le SDK ou la CI ; les exécutions récurrentes sont mises en place par l'utilisateur.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Optimisation automatique des prompts",
        baseline:
          "Une exécution d'optimisation cherche de meilleurs prompts et prouve le gain selon la même rubrique.",
        competitor:
          "Propose un playground de prompts et un suivi d'expériences ; la recherche de prompts est pilotée par l'utilisateur.",
        sourceId: "bt-docs",
      },
      {
        dimension: "À qui ça s'adresse",
        baseline:
          "Les collègues techniques et non techniques partagent un même espace de travail ; les membres en lecture seule peuvent voir les résultats sans les modifier.",
        competitor:
          "Plateforme orientée développeurs, centrée sur le SDK et les évaluations définies en code.",
        sourceId: "bt-home",
      },
      {
        dimension: "Pour commencer",
        baseline:
          "Offre gratuite sans carte bancaire ; créez une rubrique dans le navigateur.",
        competitor:
          "Offre gratuite disponible ; consultez les tarifs de Braintrust pour les limites actuelles.",
        sourceId: "bt-pricing",
      },
    ],
  },
  langsmith: {
    metaTitle: "Baseline vs LangSmith : évaluation des LLM comparée",
    metaDescription:
      "Comment Baseline et LangSmith se comparent pour évaluer les sorties d'IA : notation par rubriques, exécutions d'évaluation planifiées et optimisation automatique des prompts. Vérifié, daté et sourcé.",
    heading: "Baseline vs LangSmith",
    intro:
      "LangSmith et Baseline aident tous deux les équipes à mesurer si leur IA est assez bonne pour être lancée. La différence, c'est ce qui se passe après le score : Baseline transforme chaque évaluation en une rubrique que vous réexécutez avec une planification et confiez à une exécution d'optimisation qui améliore les prompts pour vous, si bien que la qualité continue de progresser sans ingénieur dans la boucle.",
    whyBaseline: [
      "Notez les sorties d'IA selon une rubrique que toute votre équipe peut lire, sans notebook.",
      "Mettez la qualité en pilote automatique : une planification réexécute vos évaluations et signale les régressions avant vos clients.",
      "Laissez une exécution d'optimisation réécrire les prompts faibles pour vous, puis prouvez le gain selon la même rubrique.",
    ],
    rows: [
      {
        dimension: "Notation des sorties d'IA basée sur des rubriques",
        baseline:
          "Critères pondérés créés dans l'interface ; chaque exécution d'évaluation renvoie un score global que toute l'équipe peut lire.",
        competitor:
          "Fournit des évaluateurs et une notation LLM comme juge configurés via le SDK ou l'interface.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Évaluations planifiées et récurrentes",
        baseline:
          "Une planification réexécute une rubrique à une cadence donnée sur un système connecté et fait remonter les régressions automatiquement.",
        competitor:
          "Évalue des traces et des jeux de données enregistrés depuis le SDK ou la CI ; les exécutions récurrentes sont mises en place par l'utilisateur.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Optimisation automatique des prompts",
        baseline:
          "Une exécution d'optimisation cherche de meilleurs prompts et prouve le gain selon la même rubrique.",
        competitor:
          "Centré sur le traçage, les jeux de données et les expériences ; l'itération des prompts est pilotée par l'utilisateur.",
        sourceId: "ls-docs",
      },
      {
        dimension: "À qui ça s'adresse",
        baseline:
          "Les collègues techniques et non techniques partagent un même espace de travail ; les membres en lecture seule peuvent voir les résultats sans les modifier.",
        competitor:
          "Orienté développeurs, étroitement intégré à l'écosystème LangChain.",
        sourceId: "ls-home",
      },
      {
        dimension: "Pour commencer",
        baseline:
          "Offre gratuite sans carte bancaire ; créez une rubrique dans le navigateur.",
        competitor:
          "Offre gratuite disponible ; consultez les tarifs de LangSmith pour les limites actuelles.",
        sourceId: "ls-pricing",
      },
    ],
  },
  humanloop: {
    metaTitle: "Baseline vs Humanloop : évaluation des LLM comparée",
    metaDescription:
      "Comment Baseline et Humanloop se comparent pour évaluer les sorties d'IA : notation par rubriques, exécutions d'évaluation planifiées et optimisation automatique des prompts. Vérifié, daté et sourcé.",
    heading: "Baseline vs Humanloop",
    intro:
      "Humanloop et Baseline aident tous deux les équipes à juger et améliorer leur IA. La différence, c'est la boucle : Baseline transforme chaque évaluation en une rubrique que vous réexécutez avec une planification et confiez à une exécution d'optimisation qui réécrit les prompts pour vous, si bien que l'amélioration est automatique et non une tâche de plus pour quelqu'un.",
    whyBaseline: [
      "Notez les sorties d'IA selon une rubrique que toute votre équipe peut lire, sans notebook.",
      "Mettez la qualité en pilote automatique : une planification réexécute vos évaluations et signale les régressions avant vos clients.",
      "Laissez une exécution d'optimisation réécrire les prompts faibles pour vous, puis prouvez le gain selon la même rubrique.",
    ],
    rows: [
      {
        dimension: "Notation des sorties d'IA basée sur des rubriques",
        baseline:
          "Critères pondérés créés dans l'interface ; chaque exécution d'évaluation renvoie un score global que toute l'équipe peut lire.",
        competitor:
          "Fournit des évaluateurs, humains et LLM comme juge inclus, gérés dans son interface.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Évaluations planifiées et récurrentes",
        baseline:
          "Une planification réexécute une rubrique à une cadence donnée sur un système connecté et fait remonter les régressions automatiquement.",
        competitor:
          "Lance des évaluations depuis le SDK ou la CI ; les exécutions récurrentes sont mises en place par l'utilisateur.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Optimisation automatique des prompts",
        baseline:
          "Une exécution d'optimisation cherche de meilleurs prompts et prouve le gain selon la même rubrique.",
        competitor:
          "Se concentre sur la gestion et le versionnage des prompts ; les changements de prompt sont pilotés par l'auteur.",
        sourceId: "hl-docs",
      },
      {
        dimension: "À qui ça s'adresse",
        baseline:
          "Les collègues techniques et non techniques partagent un même espace de travail ; les membres en lecture seule peuvent voir les résultats sans les modifier.",
        competitor:
          "Destiné aux équipes produit et ingénierie qui collaborent sur les prompts.",
        sourceId: "hl-home",
      },
      {
        dimension: "Pour commencer",
        baseline:
          "Offre gratuite sans carte bancaire ; créez une rubrique dans le navigateur.",
        competitor:
          "Consultez les tarifs de Humanloop pour les offres actuelles et les détails de l'essai.",
        sourceId: "hl-pricing",
      },
    ],
  },
  langfuse: {
    metaTitle: "Baseline vs Langfuse : évaluation des LLM comparée",
    metaDescription:
      "Comment Baseline et Langfuse se comparent pour évaluer les sorties d'IA : notation par rubriques, exécutions d'évaluation planifiées et optimisation automatique des prompts. Vérifié, daté et sourcé.",
    heading: "Baseline vs Langfuse",
    intro:
      "Langfuse et Baseline aident tous deux les équipes à mesurer la qualité de l'IA. La différence, c'est ce que vous faites du résultat : Baseline transforme chaque évaluation en une rubrique que vous réexécutez avec une planification et confiez à une exécution d'optimisation qui améliore les prompts pour vous, si bien que la qualité continue de progresser sans qu'un ingénieur ait à la surveiller.",
    whyBaseline: [
      "Notez les sorties d'IA selon une rubrique que toute votre équipe peut lire, sans notebook.",
      "Mettez la qualité en pilote automatique : une planification réexécute vos évaluations et signale les régressions avant vos clients.",
      "Laissez une exécution d'optimisation réécrire les prompts faibles pour vous, puis prouvez le gain selon la même rubrique.",
    ],
    rows: [
      {
        dimension: "Notation des sorties d'IA basée sur des rubriques",
        baseline:
          "Critères pondérés créés dans l'interface ; chaque exécution d'évaluation renvoie un score global que toute l'équipe peut lire.",
        competitor:
          "Enregistre des scores LLM comme juge et personnalisés sur les traces, configurés par l'utilisateur.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Évaluations planifiées et récurrentes",
        baseline:
          "Une planification réexécute une rubrique à une cadence donnée sur un système connecté et fait remonter les régressions automatiquement.",
        competitor:
          "Prend en charge les évaluations sur les traces et les jeux de données ; la cadence est configurée par l'utilisateur.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Optimisation automatique des prompts",
        baseline:
          "Une exécution d'optimisation cherche de meilleurs prompts et prouve le gain selon la même rubrique.",
        competitor:
          "Centré sur le traçage, les jeux de données et les expériences ; l'itération des prompts est pilotée par l'utilisateur.",
        sourceId: "lf-docs",
      },
      {
        dimension: "À qui ça s'adresse",
        baseline:
          "Les collègues techniques et non techniques partagent un même espace de travail ; les membres en lecture seule peuvent voir les résultats sans les modifier.",
        competitor:
          "Orienté développeurs et open source, avec auto-hébergement possible.",
        sourceId: "lf-home",
      },
      {
        dimension: "Pour commencer",
        baseline:
          "Offre gratuite sans carte bancaire ; créez une rubrique dans le navigateur.",
        competitor:
          "Open source avec une offre cloud gratuite ; consultez les tarifs de Langfuse pour les limites actuelles.",
        sourceId: "lf-pricing",
      },
    ],
  },
  arize: {
    metaTitle: "Baseline vs Arize AI : évaluation des LLM comparée",
    metaDescription:
      "Comment Baseline et Arize AI se comparent pour évaluer les sorties d'IA : notation par rubriques, exécutions d'évaluation planifiées et optimisation automatique des prompts. Vérifié, daté et sourcé.",
    heading: "Baseline vs Arize AI",
    intro:
      "Arize AI et Baseline aident tous deux les équipes à savoir si leur IA est assez bonne pour être lancée. La différence, c'est ce qui se passe après le score : Arize se concentre sur le traçage et l'observabilité pour les ingénieurs, tandis que Baseline transforme chaque évaluation en une rubrique que vous réexécutez avec une planification et confiez à une exécution d'optimisation qui améliore les prompts pour vous, si bien que la qualité continue de progresser sans qu'un ingénieur ait à la surveiller.",
    whyBaseline: [
      "Notez les sorties d'IA selon une rubrique que toute votre équipe peut lire, sans notebook.",
      "Mettez la qualité en pilote automatique : une planification réexécute vos évaluations et signale les régressions avant vos clients.",
      "Laissez une exécution d'optimisation réécrire les prompts faibles pour vous, puis prouvez le gain selon la même rubrique.",
    ],
    rows: [
      {
        dimension: "Notation des sorties d'IA basée sur des rubriques",
        baseline:
          "Critères pondérés créés dans l'interface ; chaque exécution d'évaluation renvoie un score global que toute l'équipe peut lire.",
        competitor:
          "Fournit des évaluations LLM comme juge (pertinence, toxicité et qualité) configurées via Phoenix ou le SDK.",
        sourceId: "az-docs",
      },
      {
        dimension: "Évaluations planifiées et récurrentes",
        baseline:
          "Une planification réexécute une rubrique à une cadence donnée sur un système connecté et fait remonter les régressions automatiquement.",
        competitor:
          "Évalue les traces et les jeux de données depuis le SDK ou l'interface ; les exécutions récurrentes sont mises en place par l'utilisateur.",
        sourceId: "az-docs",
      },
      {
        dimension: "Optimisation automatique des prompts",
        baseline:
          "Une exécution d'optimisation cherche de meilleurs prompts et prouve le gain selon la même rubrique.",
        competitor:
          "Propose un playground de prompts et une gestion des prompts avec versionnage ; les changements de prompt sont pilotés par l'utilisateur.",
        sourceId: "az-docs",
      },
      {
        dimension: "À qui ça s'adresse",
        baseline:
          "Les collègues techniques et non techniques partagent un même espace de travail ; les membres en lecture seule peuvent voir les résultats sans les modifier.",
        competitor:
          "Orienté développeurs et ingénieurs ML, centré sur le traçage OpenTelemetry et l'observabilité.",
        sourceId: "az-home",
      },
      {
        dimension: "Pour commencer",
        baseline:
          "Offre gratuite sans carte bancaire ; créez une rubrique dans le navigateur.",
        competitor:
          "Phoenix open source plus une offre managée gratuite ; consultez les tarifs d'Arize pour les limites actuelles.",
        sourceId: "az-pricing",
      },
    ],
  },
};
