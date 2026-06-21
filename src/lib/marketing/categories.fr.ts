import type { CategoryTranslation } from "./categories";

/**
 * French (fr) translations for the category landers (#280), keyed by slug. The
 * canonical English lives in `categories.ts`; this file overlays its prose at
 * lookup time (see `getCategory`). Product vocabulary follows the app's own fr
 * catalog: rubrique, exécution d'évaluation, planification, exécution
 * d'optimisation, équipe, système. "Baseline" is the brand and stays untranslated.
 *
 * Machine-drafted, pending native-speaker review before the locale set widens in
 * production (the editorial gate ADR-0013 calls for).
 */
export const CATEGORIES_FR: Record<string, CategoryTranslation> = {
  "llm-evaluation": {
    metaTitle:
      "Évaluation des LLM : mesurez et améliorez la qualité de l'IA | Baseline",
    metaDescription:
      "L'évaluation des LLM permet aux équipes de vérifier si leur IA est assez bonne pour être lancée, et de le rester. Baseline transforme l'évaluation en rubriques, exécutions planifiées et optimisation automatique, sans équipe de data science.",
    heading: "Une évaluation des LLM que toute votre équipe peut vraiment mener",
    ogSubtitle: "Mesurez la qualité de l'IA. Faites-la progresser.",
    intro:
      "L'évaluation des LLM permet de savoir si votre IA est assez bonne pour la présenter à vos clients, avant qu'ils ne vous disent le contraire. Baseline la rend mesurable et reproductible. Vous définissez une fois ce qu'est un bon résultat, vous notez chaque sortie selon cette définition, et vous laissez le système repérer les régressions et améliorer tout seul les prompts les plus faibles.",
    explainer: [
      "Les grands modèles de langage ne sont pas déterministes. Le même prompt peut renvoyer une excellente réponse aujourd'hui et une réponse confuse demain. Sans évaluation, vous lancez au jugé : quelqu'un regarde quelques sorties, les déclare « assez bonnes », et la qualité dérive dès qu'un prompt, un modèle ou un fournisseur change en dessous.",
      "L'évaluation des LLM remplace le coup d'œil par une mesure. Vous décidez à quoi ressemble une bonne sortie, vous en faites des critères et vous notez les sorties selon ces critères de façon cohérente. « Notre IA fonctionne-t-elle ? » cesse d'être une opinion et devient un nombre que vous pouvez suivre dans le temps et d'une version à l'autre.",
      "Bien menée, l'évaluation n'est pas un audit ponctuel. Elle s'exécute en continu, signale les régressions avant que les clients ne les rencontrent et alimente directement l'amélioration du produit. C'est exactement cette boucle qui est au cœur de Baseline.",
    ],
    howBaseline: [
      {
        feature: "Rubriques",
        body: "Écrivez à quoi ressemble une bonne sortie sous forme de critères pondérés et en langage clair, sans aucun notebook ni framework d'évaluation à apprendre. Chaque exécution d'évaluation note selon cette unique définition partagée.",
      },
      {
        feature: "Exécutions d'évaluation",
        body: "Notez un lot de sorties d'IA selon une rubrique et obtenez un seul nombre global que toute l'équipe peut lire, ainsi que le détail par critère qui l'explique.",
      },
      {
        feature: "Planifications",
        body: "Mettez l'évaluation en pilote automatique. Une planification réexécute une rubrique sur votre système en production à la cadence choisie, si bien qu'une régression apparaît sur un tableau de bord plutôt que dans un ticket de support.",
      },
      {
        feature: "Exécutions d'optimisation",
        body: "Quand la qualité baisse, confiez la rubrique à une exécution d'optimisation qui cherche de meilleurs prompts et prouve le gain selon les mêmes critères.",
      },
    ],
    outcomes: [
      "Remplacez le « ça me paraît bien » par un score de qualité auquel toute votre équipe se fie.",
      "Repérez automatiquement les régressions quand un modèle, un prompt ou un fournisseur change.",
      "Donnez aux collègues non techniques un moyen de juger la qualité de l'IA sans lire de code.",
      "Faites de chaque évaluation un point de départ pour améliorer le produit.",
    ],
    faqs: [
      {
        question: "Faut-il une équipe de data science pour évaluer un LLM ?",
        answer:
          "Non. Baseline est conçu pour qu'un chef de produit ou un expert métier rédige une rubrique dans le navigateur et lise les résultats. L'évaluation est une activité d'équipe, pas une affaire de spécialistes.",
      },
      {
        question: "En quoi est-ce différent de tester des prompts à la main ?",
        answer:
          "Tester à la main vérifie quelques sorties une fois puis les oublie. L'évaluation note chaque sortie selon une définition fixe de la qualité, s'exécute de façon planifiée et suit la tendance, si bien que vous repérez la dérive au lieu de la redécouvrir.",
      },
      {
        question: "Puis-je commencer gratuitement ?",
        answer:
          "Oui. Baseline propose une offre gratuite sans carte bancaire. Créez une rubrique et lancez votre première évaluation dans le navigateur.",
      },
    ],
  },
  "llm-as-judge": {
    metaTitle: "LLM comme juge : une notation automatique fiable | Baseline",
    metaDescription:
      "Le LLM comme juge utilise un modèle d'IA pour noter les sorties d'un autre à grande échelle. Baseline rend ce jugement cohérent et lisible, noté selon une rubrique que toute votre équipe approuve plutôt qu'une boîte noire.",
    heading: "Le LLM comme juge, rendu cohérent et vérifiable",
    ogSubtitle: "Une notation automatique à laquelle vous pouvez vous fier.",
    intro:
      "Le LLM comme juge permet de noter des milliers de sorties d'IA sans des milliers d'heures de relecture humaine. Vous demandez à un modèle compétent de noter le travail selon vos critères. L'enjeu, c'est la confiance, car un évaluateur sans fondement n'est qu'un avis de plus. Baseline ancre le juge à une rubrique rédigée par votre équipe, si bien que les scores sont cohérents, explicables et vérifiables.",
    explainer: [
      "La relecture humaine est la référence pour juger la qualité de l'IA, et elle ne passe pas à l'échelle. Relire chaque sortie à la main est lent, coûteux et variable d'un relecteur à l'autre, si bien que la plupart des équipes vérifient un échantillon minime en espérant qu'il soit représentatif.",
      "Le LLM comme juge comble cet écart. Un modèle puissant lit chaque sortie et la note selon vos critères, comme le ferait un relecteur expérimenté, mais en quelques secondes et à n'importe quel volume. Le risque, c'est qu'un juge sans contrainte reste opaque : vous obtenez un nombre sans savoir pourquoi, et deux exécutions ne s'accordent jamais.",
      "La solution, c'est le fondement. Quand le juge note selon une rubrique explicite et pondérée plutôt qu'un vague « est-ce bon ? », ses jugements deviennent cohérents et auditables. Vous pouvez voir quel critère a provoqué un score bas et vérifier vous-même la décision. C'est la différence entre un évaluateur utile et une boîte noire.",
    ],
    howBaseline: [
      {
        feature: "Jugement ancré à la rubrique",
        body: "Le juge note selon les mêmes critères pondérés que ceux rédigés par votre équipe, et non un standard interne invisible, si bien que chaque score renvoie à un critère que vous pouvez lire.",
      },
      {
        feature: "Détail par critère",
        body: "Chaque exécution d'évaluation montre comment le juge a noté chaque critère, si bien qu'un nombre global bas vient avec sa raison. Sans deviner pourquoi une sortie a échoué.",
      },
      {
        feature: "Des exécutions cohérentes",
        body: "Comme la rubrique est fixe, les mêmes sorties sont notées de la même façon d'une exécution à l'autre. Vous mesurez l'IA, pas l'humeur de l'évaluateur.",
      },
      {
        feature: "L'humain dans la boucle",
        body: "Vérifiez par sondage les décisions du juge et gardez la rubrique honnête. La notation automatique gère le volume, et votre équipe garde le dernier mot.",
      },
    ],
    outcomes: [
      "Notez des milliers de sorties sans des milliers d'heures de relecture.",
      "Obtenez des scores assortis de raisons, pas seulement un nombre.",
      "Gardez une notation cohérente d'une exécution à l'autre parce que les critères ne bougent pas.",
      "Auditez et corrigez le juge dès que nécessaire.",
    ],
    faqs: [
      {
        question:
          "Peut-on vraiment confier à un LLM la notation d'un autre LLM ?",
        answer:
          "Oui, lorsque le juge est ancré à une rubrique explicite et que son raisonnement par critère reste visible pour la relecture. Baseline repose sur ce fondement, et vous pouvez toujours vérifier par sondage ou corriger une décision.",
      },
      {
        question: "Les scores ne seront-ils pas différents à chaque fois ?",
        answer:
          "La dérive vient d'instructions vagues. Noter selon des critères fixes et pondérés rend les exécutions comparables, si bien qu'un changement de score reflète l'évolution de l'IA, pas celle de l'évaluateur.",
      },
      {
        question: "Le LLM comme juge remplace-t-il la relecture humaine ?",
        answer:
          "C'est un multiplicateur de force. Le juge gère le volume, tandis que votre équipe fixe les critères et garde le dernier mot sur les décisions qui comptent.",
      },
    ],
  },
  "prompt-optimization": {
    metaTitle:
      "Optimisation des prompts : finissez-en avec les réglages manuels | Baseline",
    metaDescription:
      "Optimiser les prompts, c'est trouver de façon systématique des prompts qui obtiennent un meilleur score, au lieu de bricoler à la main en espérant. Baseline mène la recherche pour vous et prouve le gain selon votre rubrique.",
    heading: "L'optimisation des prompts sans devinettes",
    ogSubtitle: "De meilleurs prompts, trouvés et prouvés pour vous.",
    intro:
      "L'optimisation des prompts permet d'obtenir un prompt nettement meilleur sans passer une semaine à retoucher des formulations en espérant. Baseline la traite comme une recherche. Elle génère et teste des variantes de prompt, note chacune selon votre rubrique et vous renvoie la version qui gagne de façon mesurable, preuve à l'appui.",
    explainer: [
      "La plupart des équipes améliorent les prompts à la main : elles changent une phrase, testent quelques exemples, décident que c'est mieux et le lancent. C'est lent, ça ne passe pas l'échelle au-delà de deux ou trois prompts, et « c'est mieux » est justement ce jugement non mesuré que l'évaluation existe pour remplacer.",
      "L'optimisation des prompts rend l'amélioration systématique. Le système explore de nombreux prompts candidats, note chacun selon les mêmes critères et garde ce qui performe vraiment. Elle transforme l'ingénierie de prompts, devinette d'une seule personne, en une recherche mesurée.",
      "Un meilleur score vaut davantage quand vous pouvez le défendre. Quand un nouveau prompt dépasse la rubrique approuvée par votre équipe, vous pouvez le lancer en sachant que le gain est réel et montrer ce nombre à qui le demande.",
    ],
    howBaseline: [
      {
        feature: "Exécutions d'optimisation",
        body: "Pointez une exécution vers le prompt à améliorer, et elle cherche des variantes plus solides automatiquement, au lieu que vous éditiez et retestiez à la main.",
      },
      {
        feature: "Noté selon votre rubrique",
        body: "Chaque candidat est noté selon les mêmes critères que ceux de votre évaluation, si bien qu'un gagnant est celui qui dépasse votre vraie définition de la qualité, pas un autre benchmark.",
      },
      {
        feature: "Gain prouvé",
        body: "L'exécution indique le score avant et après selon cette rubrique, si bien que l'amélioration est un nombre que vous pouvez montrer, pas une intuition.",
      },
      {
        feature: "La boucle bouclée",
        body: "La rubrique qui a repéré la régression pilote la correction. Évaluation et amélioration ne font qu'un seul flux de travail, pas deux outils déconnectés.",
      },
    ],
    outcomes: [
      "Cessez de consacrer du temps d'ingénierie à régler les prompts à la main.",
      "Améliorez des prompts que vos experts non techniques ne peuvent pas éditer mais peuvent évaluer.",
      "Lancez des changements de prompt avec la preuve du gain, pas un ressenti.",
      "Transformez une évaluation ratée directement en un meilleur prompt.",
    ],
    faqs: [
      {
        question: "En quoi est-ce différent d'un playground de prompts ?",
        answer:
          "Un playground vous laisse essayer les prompts un par un et juger à l'œil. L'optimisation cherche de nombreux candidats pour vous et note chacun selon votre rubrique, si bien que le gagnant est mesuré, pas choisi à l'intuition.",
      },
      {
        question: "Dois-je faire confiance au nouveau prompt à l'aveugle ?",
        answer:
          "Non. Chaque exécution d'optimisation indique le score avant et après selon la rubrique même de votre évaluation, si bien que vous lancez le changement en sachant exactement combien il a aidé.",
      },
      {
        question: "Qui peut lancer une optimisation ?",
        answer:
          "Quiconque sait lire des résultats. L'expert propriétaire de la rubrique lance une exécution et passe en revue le gain prouvé, sans aucune expérience en ingénierie de prompts.",
      },
    ],
  },
  "rubric-based-evaluation": {
    metaTitle: "Évaluation par rubrique : définissez la qualité une fois | Baseline",
    metaDescription:
      "L'évaluation par rubrique transforme une idée floue de « bonne sortie » en critères explicites et pondérés que toute votre équipe approuve. Baseline fait de la rubrique la définition partagée et réutilisable selon laquelle s'exécutent chaque évaluation et chaque optimisation.",
    heading: "Évaluation par rubrique : une seule définition de la qualité",
    ogSubtitle: "Définissez la qualité une fois. Réutilisez-la partout.",
    intro:
      "L'évaluation par rubrique permet de donner à « bonne sortie » le même sens pour tout le monde, pour que la qualité cesse de vivre dans la tête de chaque relecteur. Vous l'écrivez une fois sous forme de critères pondérés, et cette rubrique devient l'unique définition selon laquelle mesurent chaque exécution d'évaluation, chaque planification et chaque exécution d'optimisation.",
    explainer: [
      "Demandez à trois personnes si une réponse d'IA est « bonne » et vous obtiendrez trois réponses. L'une tient à l'exactitude, une autre au ton, une autre à la longueur. Ce désaccord reste invisible jusqu'à ce qu'il se traduise par une qualité inconsistante au lancement, et c'est pourquoi des scores que personne n'a définis sont des scores auxquels personne ne se fie.",
      "Une rubrique rend le standard explicite. Vous découpez « bon » en critères nommés et vous les pondérez selon ce qui compte vraiment pour votre produit. Désormais, tout le monde, et chaque évaluateur automatique, note selon la même chose. Le jugement flou devient un artefact partagé et écrit dont votre équipe est propriétaire.",
      "Comme la rubrique est un objet unique et réutilisable, elle relie tout le flux de travail. Les critères qui définissent une exécution d'évaluation réussie pilotent les vérifications planifiées et l'optimisation qui corrige les régressions. Changez la définition de la qualité à un endroit et tout le reste suit.",
    ],
    howBaseline: [
      {
        feature: "Critères pondérés",
        body: "Rédigez les critères qui définissent une bonne sortie et pondérez-les par importance, pour que le score global reflète ce qui compte vraiment pour votre produit.",
      },
      {
        feature: "Créées dans l'interface",
        body: "Créez et modifiez des rubriques dans le navigateur, en langage clair. L'expert métier qui sait à quoi ressemble la qualité est propriétaire de la définition, sans aucun code.",
      },
      {
        feature: "Une définition partagée",
        body: "Toute l'équipe note selon la même rubrique, et les membres en lecture seule peuvent voir les résultats sans changer les critères, si bien que le standard reste stable.",
      },
      {
        feature: "Réutilisée dans tout le flux",
        body: "La même rubrique alimente des exécutions d'évaluation ponctuelles, des planifications récurrentes et des exécutions d'optimisation. Définissez la qualité une fois et réutilisez-la partout.",
      },
    ],
    outcomes: [
      "Faites en sorte que chaque relecteur note selon la même définition de la qualité.",
      "Faites de la qualité un artefact explicite et écrit plutôt qu'un savoir tribal.",
      "Laissez les experts métier être propriétaires des critères sans toucher au code.",
      "Réutilisez une seule rubrique en évaluation, supervision et optimisation.",
    ],
    faqs: [
      {
        question: "Qu'est-ce qu'une rubrique, exactement, ici ?",
        answer:
          "Un ensemble de critères pondérés qui définissent une bonne sortie, rédigés en langage clair dans le navigateur. C'est le standard unique et partagé selon lequel note chaque évaluation, planification et optimisation.",
      },
      {
        question: "Qui rédige la rubrique ?",
        answer:
          "La personne qui sait à quoi ressemble la qualité, généralement un expert métier ou un responsable produit plutôt qu'un ingénieur. Baseline est conçu pour qu'elle la rédige et la modifie directement dans l'interface.",
      },
      {
        question: "Puis-je changer les critères plus tard ?",
        answer:
          "Oui. Modifiez la rubrique, et chaque exécution d'évaluation, planification et exécution d'optimisation qui la référence mesurera selon la définition mise à jour. Un seul changement, appliqué partout.",
      },
    ],
  },
  "reduce-ai-hallucinations": {
    metaTitle:
      "Réduire les hallucinations de l'IA : devancez vos clients | Baseline",
    metaDescription:
      "Les hallucinations sont des réponses sûres d'elles mais fausses. Baseline vous aide à mesurer la fréquence à laquelle votre IA invente, à repérer les nouvelles de façon planifiée et à faire baisser le taux avec des rubriques pensées pour l'exactitude.",
    heading: "Réduisez les hallucinations de l'IA avant qu'elles n'atteignent vos clients",
    ogSubtitle: "Repérez les réponses inventées avant vos clients.",
    intro:
      "Une hallucination est une réponse que votre IA donne avec assurance et qui est tout simplement fausse. Vous ne pouvez pas empêcher un modèle d'en produire, mais vous pouvez mesurer leur fréquence, repérer les nouvelles avant le lancement et faire baisser le taux régulièrement. Baseline vous donne la rubrique, les vérifications planifiées et la boucle d'optimisation pour faire exactement cela.",
    explainer: [
      "Les hallucinations sont dangereuses parce qu'elles sont sûres d'elles. Le modèle ne signale pas la réponse comme une supposition, si bien qu'un prix erroné, une politique inventée ou une citation fabriquée se lisent exactement comme une réponse correcte. Quand un client s'en aperçoit, le mal est fait.",
      "Vous réduisez les hallucinations comme vous corrigez tout problème de qualité invisible : vous le rendez mesurable. Définissez à quoi ressemble une réponse fondée et exacte, notez des sorties réelles selon cette définition, et « à quelle fréquence notre IA invente-t-elle ? » devient un nombre que vous pouvez surveiller au lieu d'un ressenti que l'on débat.",
      "Une fois le taux mesuré, vous pouvez agir dessus. Les vérifications planifiées repèrent un nouveau pic le jour où un prompt ou un modèle change, et une passe d'optimisation réécrit les prompts qui produisent le plus d'erreurs. Le nombre baisse, et vous pouvez le prouver.",
    ],
    howBaseline: [
      {
        feature: "Rubriques axées sur l'exactitude",
        body: "Rédigez des critères qui récompensent les réponses fondées et vérifiables et pénalisent les faits inventés, pour que chaque exécution d'évaluation note à quel point votre IA est véridique, pas seulement à quel point elle paraît fluide.",
      },
      {
        feature: "Un taux d'hallucination mesuré",
        body: "Chaque exécution d'évaluation transforme un lot de sorties en un score lisible, si bien que vous voyez la fréquence à laquelle votre IA s'écarte et suivez ce nombre de version en version.",
      },
      {
        feature: "Vérifications planifiées des régressions",
        body: "Une planification réexécute la rubrique sur votre système en production à la cadence choisie, si bien qu'une hausse des réponses inventées apparaît sur un tableau de bord le jour même où elle commence, pas dans une réclamation client.",
      },
      {
        feature: "Une optimisation qui cible les erreurs",
        body: "Confiez la rubrique à une exécution d'optimisation : elle cherche des prompts qui tiennent le cap de l'exactitude, puis prouve la baisse selon le même score.",
      },
    ],
    outcomes: [
      "Mettez un vrai chiffre sur la fréquence à laquelle votre IA invente.",
      "Repérez un nouveau pic d'hallucinations le jour où un prompt ou un modèle change.",
      "Récompensez les réponses fondées avec des rubriques que toute votre équipe peut lire.",
      "Montrez l'amélioration de l'exactitude au lieu de seulement l'affirmer.",
    ],
    faqs: [
      {
        question: "Peut-on vraiment empêcher un LLM d'halluciner ?",
        answer:
          "Pas entièrement, et quiconque promet zéro en fait trop. Ce que vous pouvez faire, c'est mesurer le taux, repérer tôt les régressions et le faire baisser avec de meilleurs prompts et un meilleur ancrage. Baseline est conçu pour cette boucle.",
      },
      {
        question: "Comment mesurer quelque chose d'aussi flou qu'une hallucination ?",
        answer:
          "Vous définissez à quoi ressemble une réponse fondée et exacte sous forme de critères de rubrique, puis vous notez les sorties selon elle. L'inquiétude floue devient un nombre que vous pouvez suivre dans le temps.",
      },
      {
        question: "Ai-je besoin d'ingénieurs pour mettre cela en place ?",
        answer:
          "Non. Un expert métier qui sait à quoi ressemble une réponse correcte peut rédiger la rubrique dans le navigateur et lire les résultats. Repérer les hallucinations est un effort d'équipe, pas une affaire de spécialistes.",
      },
    ],
  },
  "ai-agent-testing": {
    metaTitle:
      "Test d'agents IA : évaluez les agents de façon planifiée | Baseline",
    metaDescription:
      "Les agents IA sont difficiles à tester parce qu'ils agissent, ils ne font pas que répondre. Baseline se connecte à votre agent, note ses sorties réelles selon une rubrique et relance la vérification de façon planifiée pour que les régressions remontent vite.",
    heading: "Un test d'agents IA qui suit une cible mouvante",
    ogSubtitle: "Testez votre agent sur son comportement réel, de façon planifiée.",
    intro:
      "Un agent IA ne se contente pas de répondre à une question. Il franchit des étapes, appelle des outils et prend des décisions. C'est ce qui le rend puissant et difficile à tester, car ce que vous vérifiez change sans cesse à mesure que vous ajustez des prompts, changez de modèle ou ajoutez des outils. Baseline se connecte à votre agent, note ses sorties réelles selon une rubrique et relance cette vérification avec une planification pour que vous repériez une régression tant qu'elle est encore peu coûteuse à corriger.",
    explainer: [
      "Tester un agent avec quelques prompts manuels vous dit qu'il a marché une fois, sur les cas que vous avez pensé à essayer. Les agents échouent sur les cas que vous n'avez pas testés : un outil renvoie quelque chose d'inattendu, un plan en plusieurs étapes dérape, une mise à jour du modèle modifie un comportement dont vous dépendiez.",
      "Tester vraiment un agent vérifie le comportement, pas un seul instantané. Vous connectez Baseline à l'agent en marche, vous lui envoyez un lot d'entrées représentatives et vous notez les sorties réelles selon les critères que vous avez définis. « L'agent fait-il toujours son travail ? » devient une mesure que vous pouvez répéter.",
      "Les agents dérivent à mesure que tout change autour d'eux, si bien qu'un test ponctuel devient vite obsolète. Une vérification planifiée continue de tester à la cadence choisie, si bien que le jour où un changement d'outil ou de modèle casse quelque chose, vous le voyez sur un tableau de bord au lieu de l'apprendre d'un utilisateur.",
    ],
    howBaseline: [
      {
        feature: "Connexions d'agent",
        body: "Connectez Baseline à votre agent en production comme une connexion d'agent, pour que les tests s'exécutent contre la chose réelle produisant des sorties réelles, pas une transcription obsolète.",
      },
      {
        feature: "Comportement noté par rubrique",
        body: "Notez les sorties réelles de l'agent selon une rubrique rédigée par votre équipe, si bien qu'une exécution réussie signifie qu'il a satisfait votre définition du travail bien fait, pas seulement qu'il a renvoyé quelque chose.",
      },
      {
        feature: "Exécutions de test planifiées",
        body: "Une planification relance l'évaluation à la cadence choisie, si bien que les régressions d'un nouveau prompt, modèle ou outil remontent en quelques heures plutôt qu'après qu'un client les a rencontrées.",
      },
      {
        feature: "Du test raté à la correction",
        body: "Quand une exécution échoue, la même rubrique pilote une exécution d'optimisation qui cherche des prompts avec lesquels l'agent performe mieux, et prouve le rétablissement selon le même score.",
      },
    ],
    outcomes: [
      "Testez votre agent sur son comportement réel, pas sur une poignée de prompts manuels.",
      "Repérez automatiquement les régressions dues à un changement de modèle, de prompt ou d'outil.",
      "Notez ce que « faire le travail » veut dire dans des termes que toute votre équipe approuve.",
      "Transformez un test d'agent raté directement en un prompt plus performant.",
    ],
    faqs: [
      {
        question:
          "En quoi tester un agent diffère-t-il de tester un seul prompt ?",
        answer:
          "Un agent franchit plusieurs étapes et utilise des outils, si bien que la sortie dépend de plus d'une réponse. Baseline note la sortie finale réelle de l'agent selon votre rubrique, et une planification continue de tester à mesure que l'agent change.",
      },
      {
        question: "Baseline exécute-t-il mon agent à ma place ?",
        answer:
          "Il se connecte à votre agent comme une connexion d'agent et lui envoie des entrées représentatives, puis note ce qui revient. Vous gardez votre agent là où il est et Baseline le mesure.",
      },
      {
        question: "Que se passe-t-il quand un test repère une régression ?",
        answer:
          "Vous voyez la baisse sur le tableau de bord, et la même rubrique peut piloter une exécution d'optimisation qui cherche de meilleurs prompts et prouve le rétablissement selon le même score.",
      },
    ],
  },
};
