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
    walkthrough: [
      {
        title: "Définissez à quoi ressemble la qualité",
        body: "Créez une rubrique : décrivez le scénario, le résultat attendu et les critères qui comptent. L'éditeur guide la structure, et le langage clair suffit.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "L'éditeur de rubrique Baseline avec une description de scénario, un résultat attendu et un mode d'évaluation renseignés pour une rubrique de réponse au support.",
        },
      },
      {
        title: "Lancez une évaluation sur des sorties réelles",
        body: "Démarrez une exécution d'évaluation depuis la rubrique : apportez un lot d'entrées et les réponses de votre IA, et Baseline note chaque ligne selon les critères. Chaque exécution rejoint l'historique de la rubrique avec son score global.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "L'historique des exécutions d'évaluation d'une rubrique dans Baseline, cinq exécutions terminées avec des scores passant de 56 % à 82 %.",
        },
      },
      {
        title: "Lisez le score, puis les raisons",
        body: "Ouvrez une exécution pour voir le détail par ligne et par critère. Chaque score s'accompagne du raisonnement écrit du juge, si bien qu'une ligne faible vous dit exactement quoi corriger.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Le détail d'une exécution d'évaluation dans Baseline montrant un score global de 82 % et le raisonnement par critère pour l'exactitude, la complétude et le ton.",
        },
      },
      {
        title: "Suivez la tendance, repérez la dérive",
        body: "Le tableau de bord suit le score de chaque rubrique dans le temps, et une planification maintient les exécutions à la cadence choisie. Une régression apparaît comme un creux sur la courbe le jour même.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "Le tableau de bord Baseline avec une courbe de score dans le temps qui monte de 56 % à 82 % et un panneau de focus par critère.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubriques",
        body: "Une définition partagée de la qualité, écrite une fois en langage clair et utilisée par chaque exécution, planification et optimisation qui suivent.",
      },
      {
        feature: "Exécutions d'évaluation",
        body: "Un lot de sorties devient un score unique que toute l'équipe peut lire, avec derrière lui le détail par critère.",
      },
      {
        feature: "Planifications",
        body: "Des exécutions récurrentes sur votre système en production gardent la mesure à jour pendant que chacun reste concentré sur le produit.",
      },
      {
        feature: "Exécutions d'optimisation",
        body: "Quand le score baisse, la même rubrique pilote une recherche automatique de meilleurs prompts et prouve le rétablissement.",
      },
    ],
    outcomes: [
      "Remplacez le « ça me paraît bien » par un score de qualité auquel toute votre équipe se fie.",
      "Repérez les régressions le jour où un modèle, un prompt ou un fournisseur change.",
      "Donnez aux collègues non techniques une lecture directe de la qualité de l'IA.",
      "Faites de chaque évaluation le point de départ de la prochaine amélioration.",
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
    walkthrough: [
      {
        title: "Donnez au juge des instructions écrites",
        body: "Chaque critère porte des étapes de notation : des instructions courtes et ordonnées que le juge suit de la même façon à chaque fois. Les pondérations disent combien chaque critère pèse dans le score global.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Des critères pondérés dans l'éditeur de rubrique Baseline, chacun avec des étapes de notation en langage clair que le juge doit suivre.",
        },
      },
      {
        title: "Le juge note et montre son travail",
        body: "Sur chaque ligne d'une exécution d'évaluation, le juge note chaque critère et écrit pourquoi. Le raisonnement figure à côté du nombre, si bien qu'un 0,80 en exactitude vient avec la phrase qui a coûté les points.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Des scores du juge par critère avec leur raisonnement écrit dans le détail d'une exécution d'évaluation Baseline.",
        },
      },
      {
        title: "Le même standard, des exécutions comparables",
        body: "Comme les critères et les étapes sont fixes, les scores s'alignent d'une exécution à l'autre. L'historique se lit comme la tendance de qualité de votre IA, notée selon le même standard à chaque fois.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "Cinq exécutions d'évaluation de la même rubrique dans Baseline, notées selon des critères identiques sur deux mois.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Jugement ancré à la rubrique",
        body: "Le juge note selon les critères pondérés rédigés par votre équipe, si bien que chaque score renvoie à un standard que vous pouvez lire et modifier.",
      },
      {
        feature: "Étapes de notation",
        body: "Chaque critère donne au juge des étapes explicites à suivre. La cohérence vient d'instructions écrites, exactement comme pour un relecteur humain expérimenté.",
      },
      {
        feature: "Un raisonnement que vous pouvez auditer",
        body: "Chaque score de critère arrive avec la justification écrite du juge, prête à être vérifiée par sondage, contestée ou utilisée pour affiner la rubrique.",
      },
      {
        feature: "Votre fournisseur, votre clé",
        body: "Apportez votre propre clé Anthropic, OpenAI, Google ou Mistral et le juge s'exécute avec elle. Les équipes payantes peuvent aussi s'appuyer sur la clé gérée de Baseline.",
      },
    ],
    outcomes: [
      "Notez des milliers de sorties en quelques minutes, à n'importe quel volume.",
      "Voyez la raison derrière chaque score, par critère et par ligne.",
      "Gardez des exécutions comparables parce que le standard de notation ne bouge pas.",
      "Vérifiez le juge par sondage et laissez à votre équipe le dernier mot.",
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
          "La dérive vient d'instructions vagues. Noter selon des critères fixes et pondérés et des étapes écrites rend les exécutions comparables, si bien qu'un changement de score reflète un changement de votre IA.",
      },
      {
        question: "Quel modèle assure le jugement ?",
        answer:
          "Celui du fournisseur pour lequel votre équipe possède une clé : apportez une clé Anthropic, OpenAI, Google ou Mistral et le jugement s'exécute avec elle, à votre propre coût en jetons. Les équipes payantes sans clé s'appuient sur la clé gérée de Baseline.",
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
    walkthrough: [
      {
        title: "Pointez une exécution vers une rubrique et un agent",
        body: "Choisissez la rubrique qui définit le succès, la connexion d'agent dont vous voulez améliorer le prompt et un budget d'essais. L'exécution fige un ensemble d'instances d'entrée dès le départ, si bien que chaque candidat est jugé sur un terrain identique.",
      },
      {
        title: "Baseline cherche, note et garde les gagnants",
        body: "L'exécution propose des variantes de prompt et teste chacune sur les entrées figées. Le mode réflexif lit le retour écrit du juge et réécrit avec intention ; le mode simple échantillonne des réécritures et garde les meilleurs scores.",
      },
      {
        title: "Lancez le gain, preuve à l'appui",
        body: "L'exécution indique les scores avant et après selon votre rubrique et place le prompt optimisé à côté du prompt de départ pour chaque module. Copiez-le quand vous êtes convaincu.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "Une exécution d'optimisation terminée dans Baseline montrant un gain de score de 74 % à 86 % et le prompt de départ à côté de la version optimisée.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Exécutions d'optimisation",
        body: "Pointez une exécution vers le prompt à améliorer, fixez un budget, et elle explore des candidats pendant que votre équipe fait autre chose.",
      },
      {
        feature: "Deux modes",
        body: "Le mode simple échantillonne des réécritures notées et garde la meilleure, adapté aux tâches ciblées. Le mode réflexif apprend du retour écrit du juge, conçu pour les rubriques exigeantes.",
      },
      {
        feature: "Un gain prouvé",
        body: "Chaque exécution indique les scores avant et après selon la rubrique même de votre évaluation, si bien que le gain est mesuré avant le lancement.",
      },
      {
        feature: "Des prompts que vous emportez avec vous",
        body: "Les prompts gagnants figurent à côté de leur prompt de départ, par module, avec copie en un clic. Votre agent, votre prompt, votre décision.",
      },
    ],
    outcomes: [
      "Récupérez les semaines d'ingénierie passées à régler les formulations à la main.",
      "Laissez les experts métier piloter la qualité des prompts via la rubrique dont ils sont propriétaires.",
      "Lancez des changements de prompt avec le chiffre avant-après à l'appui.",
      "Transformez une évaluation ratée directement en un meilleur prompt.",
    ],
    faqs: [
      {
        question: "En quoi est-ce différent d'un playground de prompts ?",
        answer:
          "Un playground vous laisse essayer les prompts un par un et juger à l'œil. Une exécution d'optimisation teste de nombreux candidats pour vous et note chacun selon votre rubrique, si bien que le gagnant est celui qui performe de façon mesurable.",
      },
      {
        question: "Comment savoir si le nouveau prompt est vraiment meilleur ?",
        answer:
          "Chaque exécution indique le score avant et après selon la rubrique même de votre évaluation et montre le prompt optimisé côte à côte avec le prompt de départ, si bien que vous passez en revue exactement ce qui a changé et ce que cela a apporté.",
      },
      {
        question: "Qu'est-ce qu'un module ?",
        answer:
          "Un prompt nommé au sein de votre agent qu'une exécution peut améliorer séparément. Une connexion d'agent déclare ses modules ; une exécution les optimise un par un et rend compte de chaque prompt séparément.",
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
    walkthrough: [
      {
        title: "Plantez le décor",
        body: "Une rubrique commence par une description de scénario et un résultat attendu en langage clair : ce que l'on demande à l'IA, et ce qu'accomplit une bonne réponse. Un contexte d'ancrage facultatif donne au juge des documents de référence pour vérifier.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "Les champs description de scénario, résultat attendu et contexte d'ancrage de l'éditeur de rubrique dans Baseline.",
        },
      },
      {
        title: "Pondérez ce qui compte",
        body: "Ajoutez des critères et pondérez-les pour que le score global reflète vos priorités. Les étapes de notation sous chaque critère disent au juge exactement comment noter, avec les mots de votre équipe.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Trois critères pondérés dans l'éditeur de rubrique Baseline : l'exactitude à 0,5, la complétude à 0,3 et le ton à 0,2, chacun avec ses étapes de notation.",
        },
      },
      {
        title: "Une rubrique, chaque mesure",
        body: "La rubrique terminée pilote aussi bien les exécutions d'évaluation ponctuelles que les planifications récurrentes et les exécutions d'optimisation. Modifiez la définition une fois et tout ce qui en dépend mesure selon la mise à jour.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "Une planification Baseline exécutant une rubrique chaque nuit sur un agent connecté, avec son historique d'exécutions.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Scénario et résultat attendu",
        body: "La rubrique capture d'abord la tâche et l'objectif en prose, si bien que les critères ont un contexte et qu'un nouveau collègue peut lire ce que « bon » veut dire ici.",
      },
      {
        feature: "Critères pondérés",
        body: "Nommez les dimensions de la qualité et pondérez-les par importance. Les pondérations totalisent 1, si bien que les priorités sont explicites et que le score global les reflète.",
      },
      {
        feature: "Étapes de notation",
        body: "Chaque critère porte les instructions pas à pas que le juge suit, ce qui transforme une étiquette comme « exactitude » en une procédure reproductible.",
      },
      {
        feature: "Propriété de l'équipe",
        body: "Les contributeurs rédigent et modifient dans le navigateur ; les membres en lecture seule voient chaque résultat pendant que le standard reste stable.",
      },
    ],
    outcomes: [
      "Chaque relecteur, humain ou automatique, note selon un seul standard écrit.",
      "La qualité devient un artefact écrit et explicite dont l'équipe est propriétaire.",
      "Les experts métier définissent la qualité directement, dans le navigateur.",
      "Une seule rubrique alimente l'évaluation, la supervision et l'optimisation.",
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
    walkthrough: [
      {
        title: "Rédigez des critères qui récompensent les réponses fondées",
        body: "Donnez à l'exactitude la pondération la plus lourde et détaillez les étapes de notation : comparer à la réponse attendue, pénaliser les faits inventés. Le contexte d'ancrage remet au juge les documents de référence pour vérifier les affirmations.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Une rubrique pondérée vers l'exactitude dans Baseline, avec des étapes de notation qui pénalisent les erreurs factuelles et les omissions.",
        },
      },
      {
        title: "Notez un lot réel et voyez où il s'égare",
        body: "Lancez une évaluation sur des sorties réelles. Le détail par ligne montre quelles réponses ont dérapé, et le raisonnement du juge nomme l'affirmation exacte qui a coûté les points.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Le raisonnement du juge dans une exécution d'évaluation Baseline signalant un détail adouci dans une réponse au support par ailleurs exacte.",
        },
      },
      {
        title: "Programmez la vérification",
        body: "Une planification de nuit ou toutes les heures re-note des sorties fraîches de votre système en production, si bien qu'un pic de réponses inventées remonte dès l'exécution suivante.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "Une planification Baseline de nuit notant un agent de support en production, avec des exécutions terminées dans son historique.",
        },
      },
      {
        title: "Faites baisser le taux et prouvez-le",
        body: "Le tableau de bord montre la tendance d'exactitude. Quand elle fléchit, une exécution d'optimisation cherche des prompts qui tiennent le cap et présente le rétablissement sous forme de chiffre.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "Une tendance d'exactitude en hausse sur le tableau de bord Baseline après des corrections de prompts.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubriques axées sur l'exactitude",
        body: "Des critères qui récompensent les réponses fondées et vérifiables, pondérés pour que l'exactitude domine le score global.",
      },
      {
        feature: "Contexte d'ancrage",
        body: "Joignez les documents de référence avec lesquels le juge vérifie les affirmations, si bien que « vrai » veut dire vrai selon vos propres documents et politiques.",
      },
      {
        feature: "Un taux mesuré",
        body: "Chaque exécution transforme un lot en un chiffre, et le raisonnement par ligne nomme chaque fait inventé qu'elle a trouvé.",
      },
      {
        feature: "Des vérifications qui continuent de tourner",
        body: "Les planifications re-notent des sorties en production à la cadence choisie ; un changement de modèle ou de prompt qui commence à déraper apparaît dès l'exécution suivante.",
      },
    ],
    outcomes: [
      "Mettez un vrai chiffre sur la fréquence à laquelle votre IA invente.",
      "Voyez les affirmations exactes qui ont échoué, avec le raisonnement du juge.",
      "Repérez un pic dès la première exécution planifiée qui suit son apparition.",
      "Montrez l'amélioration de l'exactitude comme une tendance, preuves à l'appui.",
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
        question:
          "Qu'est-ce qui rend une rubrique efficace pour repérer les hallucinations ?",
        answer:
          "Trois choses : un résultat attendu auquel le juge peut comparer, un contexte d'ancrage qui fournit les vrais documents de référence, et des étapes de notation qui pénalisent explicitement les faits inventés. Le pas-à-pas ci-dessus met les trois en place.",
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
    walkthrough: [
      {
        title: "Connectez l'agent que vous exploitez vraiment",
        body: "Une connexion d'agent pointe Baseline vers votre endpoint en production : URL, en-tête d'authentification, un modèle de requête et le chemin de réponse vers la réponse. Les identifiants sont chiffrés au repos et déchiffrés uniquement côté serveur, au moment où Baseline appelle votre système.",
        image: {
          src: "/docs/schedule-wizard-connection.png",
          alt: "La création d'une connexion d'agent en production dans l'assistant de planification de Baseline, avec l'URL de l'endpoint, l'en-tête d'authentification et le modèle de corps de requête.",
        },
      },
      {
        title: "Nommez le test et choisissez le standard",
        body: "L'assistant de planification vous guide à travers Bases, Système, Entrées, Cadence, Notifier et Vérification : choisissez la rubrique qui définit le travail bien fait et les entrées que Baseline envoie à l'agent.",
        image: {
          src: "/docs/schedule-wizard-step1.png",
          alt: "La première étape de l'assistant de planification dans Baseline, nommant une vérification nocturne des réponses au support et sélectionnant une rubrique.",
        },
      },
      {
        title: "Laissez la cadence repérer la dérive",
        body: "À chaque échéance, Baseline invoque l'agent avec des entrées représentatives et note les sorties réelles. L'historique des exécutions transforme les changements d'outils, de modèle et de prompt en mouvements de score visibles.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "L'historique des exécutions d'une planification Baseline pour un agent de support en production, avec le score de chaque exécution et l'heure de la prochaine.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Connexions d'agent",
        body: "Une définition réutilisable de la façon dont Baseline atteint votre agent : endpoint, authentification, modèle de requête, chemin de réponse. Les tests s'exécutent contre le vrai système, en direct.",
      },
      {
        feature: "Des identifiants gérés côté serveur",
        body: "Les secrets de connexion sont chiffrés au repos et en transit, et déchiffrés uniquement quand le worker appelle votre système.",
      },
      {
        feature: "Exécutions de test planifiées",
        body: "Une cadence de votre choix, de l'horaire au mensuel, avec des notifications de fin et d'échec aux collègues concernés.",
      },
      {
        feature: "Des sources de données aussi",
        body: "Pointez une connexion de données vers PostHog ou une source personnalisée et notez le trafic que votre agent a déjà produit, sans aucun appel en direct.",
      },
    ],
    outcomes: [
      "Testez le comportement réel de l'agent à une cadence régulière, sans intervention.",
      "Repérez dès l'exécution suivante les régressions dues à un changement de modèle, de prompt ou d'outil.",
      "Définissez « faire le travail » une fois, dans des termes que toute l'équipe a approuvés.",
      "Notez le trafic de production historique aussi facilement que des invocations en direct.",
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
        question:
          "Puis-je confier sans risque les identifiants d'API de mon agent à Baseline ?",
        answer:
          "Les secrets de connexion sont stockés chiffrés, jamais exposés au navigateur, et déchiffrés uniquement côté serveur au moment où Baseline appelle votre endpoint. Vous pouvez faire tourner ou supprimer les identifiants d'une connexion à tout moment.",
      },
      {
        question: "Que se passe-t-il quand un test repère une régression ?",
        answer:
          "Vous voyez la baisse sur le tableau de bord, et la même rubrique peut piloter une exécution d'optimisation qui cherche de meilleurs prompts et prouve le rétablissement selon le même score.",
      },
    ],
  },
  "simple-prompt-optimization": {
    metaTitle: "Mode Simple : optimisation rapide de prompts pour les tâches ciblées | Baseline",
    metaDescription:
      "Le Mode Simple améliore un prompt collé en essayant des réécritures notées et en gardant la meilleure. Découvrez quand le choisir plutôt que le Mode Réflexif, ce que fait chaque option d'exécution et comment une exécution est facturée.",
    heading: "Mode Simple : l'optimisation de prompts avec moins de décisions",
    ogSubtitle: "Collez un prompt. Gardez la meilleure réécriture.",
    intro:
      "Le Mode Simple est le moyen le plus rapide d'améliorer un prompt dans Baseline. Collez le prompt, ajoutez quelques entrées de test, et l'exécution essaie réécriture après réécriture, note chacune avec votre rubrique sur les mêmes entrées et vous rend la meilleure version trouvée. C'est le mode par défaut quand vous optimisez un prompt collé, et il ne vous demande qu'une seule vraie décision : combien d'appels notés vous voulez dépenser.",
    explainer: [
      "Une exécution d'optimisation en Mode Simple est un tournoi de réécritures. Votre prompt collé devient le premier candidat et il est noté sur l'ensemble complet des entrées de test, appelées instances, pour fixer la référence. Chaque tour produit ensuite jusqu'à 8 nouveaux candidats : chacun part de l'un des meilleurs prompts du moment et le réécrit d'une des cinq façons prévues, comme le rendre plus précis, ajouter un exemple travaillé, le restructurer en étapes numérotées, le condenser ou changer sa perspective.",
      "Chaque candidat est noté sur les mêmes instances figées par la même rubrique, donc les scores sont directement comparables. Après chaque tour, l'exécution garde les 3 meilleurs et réécrit à partir d'eux. Elle s'arrête au budget de rollouts, au plafond de tours ou après plusieurs tours d'affilée sans amélioration, et se termine sur le meilleur candidat trouvé, son score affiché à côté de celui de votre prompt d'origine.",
      "L'autre mode d'optimisation, Réflexif, lit le raisonnement écrit du juge sur les scores récents et propose des prompts éclairés par ce retour. Choisissez Simple pour une tâche ciblée et bien définie, comme un formateur JSON, un classifieur ou un extracteur, où le score raconte déjà toute l'histoire. Passez en Réflexif quand les critères de la rubrique sont nuancés, comme le ton ou les jugements, et que l'optimiseur doit apprendre du retour plutôt que d'un simple chiffre.",
    ],
    walkthrough: [
      {
        title: "Choisissez la rubrique qui définit le mieux",
        body: "Chaque réécriture est notée par une seule rubrique, donc l'exécution optimise exactement ce que la rubrique mesure. Choisissez-en une existante à l'étape Bases, ou écrivez-la d'abord si ce prompt n'a jamais été évalué.",
      },
      {
        title: "Collez votre prompt et gardez Simple sélectionné",
        body: "À l'étape Système, choisissez Coller un prompt, déposez le prompt et sélectionnez le modèle qui l'exécutera : Haiku 4.5 par défaut, ou Sonnet 4.6 ou Opus 4.8. Simple est présélectionné comme mode ; Réflexif est à un clic quand la tâche l'exige.",
        image: {
          src: "/docs/optimization-wizard-system-simple.png",
          alt: "L'étape Système de l'assistant d'optimisation avec Coller un prompt choisi, Simple sélectionné comme mode d'optimisation et un prompt de tri de tickets de support rempli.",
        },
      },
      {
        title: "Ajoutez les entrées de test",
        body: "Saisissez jusqu'à 50 instances à la main, ou importez-les en CSV ou JSON. Seule l'entrée utilisateur est requise ; la sortie attendue et le contexte de récupération sont facultatifs. L'ensemble est figé au démarrage de l'exécution, donc chaque candidat est jugé sur des entrées identiques.",
        image: {
          src: "/docs/optimization-wizard-instances.png",
          alt: "L'étape Instances de l'assistant d'optimisation avec trois tickets de support saisis à la main, chacun avec une entrée utilisateur et une sortie attendue.",
        },
      },
      {
        title: "Fixez le budget, et n'ajustez le reste que si vous le voulez",
        body: "Le budget de rollouts plafonne les appels notés : un rollout est un candidat noté sur une instance, la valeur par défaut est 30 et votre offre fixe le maximum par exécution (200 en Builder, 400 en Scale). Les réglages avancés portent le modèle de réécriture (le modèle rapide par défaut), le plafond de tours (20) et l'arrêt anticipé après des tours sans amélioration (5).",
        image: {
          src: "/docs/optimization-wizard-tuning.png",
          alt: "L'étape Réglages de l'assistant d'optimisation avec un budget de rollouts de 30, le modèle de génération Haiku 4.5 et les réglages avancés à 20 tours maximum et un arrêt anticipé à 5.",
        },
      },
      {
        title: "Vérifiez, lancez et récupérez le gagnant",
        body: "L'étape Vérifier affiche le mode, le nombre d'instances, le budget et si l'exécution utilise une exécution d'optimisation incluse ou consomme des points d'évaluation. À la fin, vous obtenez les scores avant et après et le prompt optimisé à côté de l'original, prêt à copier.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "Une exécution d'optimisation terminée dans Baseline montrant un score passé de 74 % à 86 %, le prompt d'origine à côté de la version optimisée.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubriques",
        body: "Votre définition de la qualité est la fonction d'aptitude de l'exécution : chaque réécriture est notée sur les mêmes critères que vos exécutions d'évaluation utilisent déjà.",
      },
      {
        feature: "Agents managés",
        body: "Baseline exécute le prompt collé sur un modèle managé : aucun endpoint à construire, rien à déployer avant de pouvoir optimiser.",
      },
      {
        feature: "Exécutions d'optimisation",
        body: "Une exécution Simple puise dans le quota mensuel d'exécutions de votre offre comme n'importe quel mode, et le budget de rollouts borne son coût avant le départ.",
      },
      {
        feature: "Mode Réflexif",
        body: "Le même assistant propose le mode guidé par le retour quand les critères de votre rubrique deviennent nuancés : dépasser Simple tient en un clic.",
      },
    ],
    outcomes: [
      "Améliorez un prompt sans connecter d'agent ni écrire d'endpoint.",
      "Un score avant/après mesuré avec votre propre rubrique, sur les mêmes entrées.",
      "Une seule décision à prendre : le budget. Les valeurs par défaut gèrent le reste.",
      "Un chemin clair vers l'optimisation guidée par le retour quand la tâche dépasse la recherche au score seul.",
    ],
    faqs: [
      {
        question: "Quand utiliser plutôt le Mode Réflexif ?",
        answer:
          "Quand la rubrique mesure des qualités nuancées, comme le ton, l'empathie ou des consignes à plusieurs volets qui interagissent. Réflexif lit le raisonnement écrit du juge et propose des prompts éclairés par lui. Simple convient mieux quand le score suffit à capturer la réussite.",
      },
      {
        question: "Comment dimensionner le budget de rollouts ?",
        answer:
          "Chaque candidat est noté une fois par instance, et votre nombre d'instances correspond simplement au nombre de lignes de test ajoutées à l'étape Instances. Avec 10 instances, chaque réécriture coûte 10 rollouts, et noter votre prompt d'origine au départ coûte les mêmes 10. Pour dimensionner le budget, comptez les prompts à noter (votre original plus chaque réécriture) et multipliez par votre nombre d'instances. Par exemple : essayer 24 réécritures (trois tours complets de 8) sur 10 instances fait 25 prompts notés, donc un budget de 250.",
      },
      {
        question: "Pourquoi le Mode Simple n'apparaît-il pas dans mon assistant ?",
        answer:
          "Le Mode Simple est proposé pour les prompts collés, qui s'exécutent comme agents managés sur la clé de Baseline, une fonctionnalité des offres payantes. Les agents connectés via votre propre endpoint s'optimisent avec le Mode Réflexif.",
      },
      {
        question: "Combien coûte une exécution ?",
        answer:
          "Une exécution d'optimisation du quota mensuel de votre offre (15 en Builder, 75 en Scale) ; au-delà du quota, une exécution payante consomme des points d'évaluation par rollout noté, et l'étape Vérifier vous dit lequel s'applique avant de lancer. Les tokens du modèle passent sur votre propre clé fournisseur si vous en avez enregistré une, sinon sur la clé managée de Baseline au coût fournisseur plus la marge de votre offre, réservée sur votre plafond de dépense managée.",
      },
      {
        question: "Que se passe-t-il si une exécution atteint le plafond de dépense en cours de route ?",
        answer:
          "L'exécution échoue immédiatement et votre prompt d'origine reste en place : une exécution coupée ne présente jamais en silence votre prompt inchangé comme un résultat optimisé. Relevez le plafond ou attendez la période suivante, puis relancez.",
      },
    ],
  },
};
