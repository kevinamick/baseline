import type { CategoryTranslation } from "./categories";

// The manual-prompt-optimization guide's copy-paste prompt, translated (#432). See
// the English original in `categories.ts` for the joined-array rationale.
const MANUAL_LOOP_PROMPT_FR = [
  "Tu m'aides à améliorer manuellement un prompt d'IA à travers des tours structurés de test et de révision. Voici comment travailler avec moi :",
  "",
  "1. Demande-moi trois choses si je ne te les ai pas encore données : mon prompt actuel, un ensemble de cas de test (chacun avec une entrée, plus une sortie attendue ou une description simple de ce à quoi ressemble une bonne réponse), et les critères selon lesquels je juge les réponses. Si quelque chose manque, aide-moi à le construire avant de commencer.",
  "2. Dès que tu as le prompt, les cas de test et les critères, passe immédiatement à la notation. Ne demande pas plus de cas de test, ne demande pas de pondérations chiffrées, ne demande pas d'exemples concrets si je t'ai donné des descriptions abstraites. Travaille exactement avec ce que je t'ai donné. Traite les cas de test abstraits ou de type schéma comme des entrées valides ; interprète-les raisonnablement et note directement par rapport à eux.",
  "3. Fais tourner le prompt actuel sur chaque cas de test. Pour chaque cas, raisonne sur ce que le prompt produirait probablement et note-le selon les critères. Consigne tous les scores dans un tableau pour avoir une base de départ claire.",
  "4. Parcours tous les cas notés et nomme le seul schéma d'échec qui revient le plus souvent : celui qui coûte le plus de points sur l'ensemble. Pas chaque petit problème, seulement le schéma dominant.",
  "5. Fais exactement un changement ciblé dans le prompt qui s'attaque à ce schéma. Ne réécris pas tout le prompt. Ne corrige pas plusieurs choses à la fois.",
  "6. Note le prompt révisé selon exactement les mêmes cas de test et les mêmes critères. Consigne les nouveaux scores dans un tableau.",
  "7. Compare le nouveau total au tour précédent. S'il s'est amélioré, garde la révision et reviens à l'étape 4. Sinon, reviens au meilleur prompt précédent et essaie un angle différent sur le même schéma d'échec.",
  "8. Répète les étapes 4 à 7. Arrête-toi après 5 tours, ou après 2 tours consécutifs sans amélioration, selon ce qui arrive en premier.",
  "9. Quand tu t'arrêtes, livre les trois éléments suivants sans attendre qu'on te les demande :",
  "   - Le prompt final complet, prêt à copier",
  "   - Un tableau montrant le score avant et après pour chaque cas de test sur tous les tours",
  "   - Un résumé court et en langage simple de ce qui a changé et pourquoi ça a aidé",
  "",
  "Deux règles pour toute la session : ne change jamais les cas de test une fois qu'on a commencé, et juge chaque changement par son effet sur l'ensemble complet, jamais parce qu'il corrige un cas préféré au détriment des autres.",
].join("\n");

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
  "ai-eval-pricing": {
    metaTitle: "Eval Points : une tarification à l'usage prévisible pour évaluer l'IA | Baseline",
    metaDescription:
      "Les Eval Points sont l'unité dans laquelle Baseline facture le travail d'évaluation. Découvrez l'arithmétique exacte par exécution, ce qui se passe quand une exécution échoue, le quota mensuel de chaque offre et comment le dépassement reste sous un plafond que vous fixez.",
    heading: "Les Eval Points, expliqués",
    ogSubtitle: "Connaissez le coût exact de chaque exécution avant de lancer.",
    intro:
      "Les Eval Points sont la façon dont Baseline facture le travail d'évaluation. Le coût de chaque exécution d'évaluation est une arithmétique exacte, vérifiable avant le lancement, votre offre inclut un quota mensuel, et un registre en append-only montre chaque mouvement. Les coûts de tokens vivent sur un compteur séparé : le nombre affiché est donc le prix plateforme complet.",
    explainer: [
      "Un Eval Point mesure du travail de plateforme : orchestrer une exécution et noter vos sorties selon les critères de votre rubrique. Chaque ligne coûte 10 points d'orchestration plus 5 points par critère noté. Une rubrique à 3 critères coûte donc 25 points par ligne, si bien qu'une exécution de 100 lignes contre elle coûte exactement 2 500 points. La formule est fixe et publique, et la boîte de dialogue d'exécution la calcule pour vous avant confirmation.",
      "Les coûts de tokens du modèle vont sur un compteur séparé, à dessein. Quand votre équipe apporte sa propre clé fournisseur, Baseline ne facture rien pour les tokens ; quand une exécution utilise la clé managée de Baseline, les tokens sont facturés au coût fournisseur plus la marge de votre offre, sous un plafond de dépense managée que vous pouvez voir et modifier. Garder les deux compteurs séparés est ce qui rend chacun prévisible.",
      "Les points transitent par un registre en append-only avec une logique de réservation puis règlement. Au démarrage d'une exécution, son coût complet est réservé en une seule étape atomique, et c'est pourquoi des exécutions simultanées ne peuvent jamais dépasser votre quota. À la fin, elle se règle : une exécution terminée conserve la réservation complète, une exécution échouée ne règle que les lignes réellement exécutées et rend le reste à votre solde. Le registre visible sur la page Facturation est la piste d'audit elle-même, entrée par entrée.",
      "Les exécutions d'optimisation puisent d'abord dans leur propre quota : votre offre inclut un nombre d'exécutions par mois (15 en Builder, 75 en Scale), et une exécution dans ce quota n'utilise aucun point. Au-delà, l'exécution d'une équipe payante consomme des Eval Points par rollout noté, au même barème par ligne, car juger un rollout est le même travail de plateforme que noter une ligne d'évaluation.",
    ],
    walkthrough: [
      {
        title: "Voyez le coût exact avant de lancer la moindre exécution",
        body: "La boîte de dialogue Run eval fait l'addition en direct à mesure que vous ajoutez des lignes : lignes fois 10, plus 5 par critère et par ligne. Une ligne contre une rubrique à 3 critères affiche 25 Eval Points. Rien ne part tant que vous n'avez pas confirmé le nombre.",
        image: {
          src: "/docs/eval-run-dialog-points.png",
          alt: "La boîte de dialogue Run eval de Baseline avec une ligne manuelle remplie et le pied indiquant : cette exécution utilisera 25 Eval Points.",
        },
      },
      {
        title: "Suivez votre solde et la date de remise à zéro sur Facturation",
        body: "La page Facturation montre vos points restants, le quota mensuel de votre offre (5 000 en Free, 100 000 en Builder, 500 000 en Scale) et le jour où le solde repart avec votre période de facturation.",
        image: {
          src: "/docs/billing-eval-points.png",
          alt: "La page Facturation de Baseline pour une équipe Builder montrant 100 000 Eval Points restants sur 100 000, la date de remise à zéro et la carte de dépassement.",
        },
      },
      {
        title: "Regardez les exécutions réserver, puis régler",
        body: "Lancer une exécution réserve son coût complet sur le registre de points en une entrée atomique. Terminer la règle : une exécution aboutie conserve la réservation, une exécution échouée ne paie que les lignes traitées et libère le reste. Chaque mouvement reste visible comme sa propre ligne du registre.",
      },
      {
        title: "Choisissez ce qui se passe à la limite",
        body: "Par défaut les exécutions s'arrêtent quand le quota est épuisé : le prix de l'offre est alors toute la facture. Les équipes payantes peuvent fixer un plafond de dépassement en dollars pour continuer au tarif par point de l'offre (0,0005 $ en Builder, 0,0003 $ en Scale), jamais au-delà du plafond, avec un e-mail d'alerte à 80 %.",
      },
    ],
    howBaseline: [
      {
        feature: "Exécutions d'évaluation",
        body: "Coûtent une arithmétique exacte par ligne et par critère, affichée dans la boîte de dialogue avant le départ, identique pour une exécution manuelle ou planifiée.",
      },
      {
        feature: "Exécutions d'optimisation",
        body: "Utilisent d'abord leur propre quota mensuel d'exécutions ; au-delà, une exécution consomme des points par rollout noté avec la même formule par ligne.",
      },
      {
        feature: "Registre de points",
        body: "Un enregistrement en append-only sur la page Facturation : dotations, réservations, règlements et libérations, pour que le solde s'explique toujours de lui-même.",
      },
      {
        feature: "Plafond de dépassement",
        body: "Un plafond optionnel en dollars qui permet aux équipes payantes de continuer au-delà du quota à un tarif fixe par point, jamais au-dessus du plafond.",
      },
    ],
    outcomes: [
      "Connaissez le coût exact de chaque exécution avant de la lancer, avec une formule visible.",
      "Une facture qui reste au prix de l'offre sauf si vous activez le dépassement plafonné.",
      "Les exécutions échouées ne règlent que le travail réellement effectué, le reste est rendu.",
      "Les coûts de tokens sur leur propre compteur transparent, à zéro quand vous apportez votre clé.",
    ],
    faqs: [
      {
        question: "Les Eval Points incluent-ils les coûts de tokens du modèle ?",
        answer:
          "Les points couvrent uniquement le travail de plateforme : orchestration et notation par critère. Les tokens sont un compteur à part. Avec votre propre clé fournisseur, Baseline n'ajoute rien à la facture de votre fournisseur ; sur la clé managée de Baseline, les tokens sont facturés au coût fournisseur plus la marge de votre offre, sous un plafond de dépense managée que vous contrôlez.",
      },
      {
        question: "Qu'est-ce qui consomme des Eval Points ?",
        answer:
          "Les exécutions d'évaluation, lancées à la main ou par une planification, à lignes fois (10 plus 5 par critère). Les exécutions d'optimisation ne consomment des points qu'une fois le quota d'exécutions inclus épuisé, au même tarif par rollout noté. Rien d'autre ne puise dans les points.",
      },
      {
        question: "Que deviennent les points quand une exécution échoue ?",
        answer:
          "La réservation se règle sur les lignes réellement exécutées et le reste revient à votre solde, comme sa propre entrée du registre. Une exécution qui meurt à la ligne 30 sur 100 paie 30 lignes.",
      },
      {
        question: "Que se passe-t-il quand mon équipe n'a plus de points ?",
        answer:
          "Les nouvelles exécutions sont refusées jusqu'à la remise à zéro du solde avec votre période de facturation. Sur une offre payante, vous pouvez plutôt fixer un plafond de dépassement : les exécutions continuent alors au tarif par point jusqu'à votre plafond, vous recevez un e-mail d'alerte à 80 %, et le plafond est le maximum que le dépassement peut facturer. Les offres Free s'arrêtent toujours au quota.",
      },
      {
        question: "Pourquoi des points plutôt qu'un compteur en dollars ?",
        answer:
          "Le travail de plateforme est dénombrable et identique d'une exécution à l'autre : il se facture proprement en unités fixes vérifiables. Les coûts de tokens varient selon le modèle et le fournisseur, ils restent donc sur leur propre compteur où chaque montant correspond à un appel précis à un tarif visible.",
      },
    ],
  },
  "manual-prompt-optimization": {
    metaTitle: "Optimisation manuelle des prompts : le processus pas à pas | Baseline",
    metaDescription:
      "L'optimisation manuelle des prompts consiste à figer un ensemble de tests, noter selon des critères fixes, puis guider un assistant IA à travers des révisions ciblées, une par tour. Voici le processus complet, le prompt à copier-coller qui l'exécute, et le moment où l'automatiser avec Baseline en vaut la peine.",
    heading: "Optimiser un prompt à la main, un tour honnête à la fois",
    ogSubtitle: "Le processus manuel de prompts, pas à pas.",
    intro:
      "Vous pouvez réellement améliorer un prompt sans rien acheter. Figez un véritable ensemble de tests, notez le prompt actuel selon un ensemble fixe de critères, puis confiez le travail de révision à un assistant IA que vous utilisez déjà : changez une seule chose, notez à nouveau, et ne gardez le changement que si le total augmente. Répétez l'opération plusieurs fois et la plupart des prompts s'améliorent nettement en un après-midi. Le vrai coût, c'est votre temps, et savoir exactement quand ce coût cesse d'en valoir la peine.",
    explainer: [
      "La plupart des gens améliorent un prompt à l'œil : ils changent une phrase, jettent un œil à deux ou trois résultats, décident que c'est mieux, et passent à autre chose. Le problème, c'est qu'on ne peut pas vraiment le savoir. Sans façon fixe de mesurer « mieux », chaque changement n'est qu'une supposition déguisée en décision.",
      "La solution ne demande aucun logiciel spécial. Figez un véritable ensemble de cas de test pour que le terrain ne bouge jamais sous vos pieds, écrivez les critères sur lesquels vous jugez, changez exactement une chose à la fois, et notez le résultat sur les mêmes cas et les mêmes critères à chaque tour. Cette seule discipline transforme l'ajustement manuel en quelque chose à qui l'on peut vraiment faire confiance.",
      "Ce qui est vraiment fastidieux, c'est de répéter cette boucle encore et encore : noter, repérer le schéma, réviser, noter à nouveau, comparer. C'est un travail mécanique, exactement ce qu'un assistant de chat peut faire à votre place dès que vous lui donnez les bonnes instructions. Ce guide parcourt tout le processus de bout en bout, avec le prompt exact à lui confier.",
    ],
    walkthrough: [
      {
        title: "Figez un ensemble de tests",
        body: "Choisissez 10 à 20 entrées réelles, du genre que votre prompt doit vraiment gérer, pas des cas limites inventés. Pour chacune, notez soit la sortie attendue, soit, quand il n'y a pas une seule bonne réponse, une description simple de ce à quoi ressemble une bonne réponse. Gardez cet ensemble exactement inchangé à chaque tour qui suit ; une cible mouvante rend toute note dénuée de sens.",
      },
      {
        title: "Notez le prompt actuel selon des critères écrits",
        body: "Avant de changer quoi que ce soit, faites tourner le prompt actuel sur chaque cas et notez chaque résultat selon un ensemble de critères fixe et écrit, pas selon une impression. Un tableur avec une ligne par cas et une colonne par critère fonctionne vraiment : écrivez une note et une raison en une ligne dans chaque cellule. Si vous préférez un endroit dédié pour stocker et refaire tourner ces notes, des plateformes comme LangSmith et Braintrust font le même travail. Dans tous les cas, notez les scores avant de toucher au prompt, pour avoir un vrai chiffre à battre.",
      },
      {
        title: "Confiez la boucle à un assistant IA",
        body: "La partie répétitive, suivre les mêmes instructions tour après tour, est exactement ce qu'un assistant de chat fait bien. Claude, ChatGPT, Copilot et Codex se valent à peu près pour ça ; utilisez celui que vous avez déjà sous la main. Collez le bloc ci-dessous dans une nouvelle conversation, puis répondez à ses questions sur votre prompt, vos cas de test et vos critères.",
        codeBlock: MANUAL_LOOP_PROMPT_FR,
      },
      {
        title: "Laissez-le itérer, et vérifiez le travail vous-même",
        body: "L'assistant va noter, réviser, noter à nouveau et rendre compte tour après tour. Lisez ses chiffres avant/après plutôt que de le croire sur parole pour une amélioration, et parcourez vous-même quelques réponses. Une mise en garde honnête : quand le même assistant réécrit le prompt et note le résultat, sa propre notation a tendance à devenir plus généreuse avec le temps. Gardez les critères fixes et vérifiez à la main quelques réponses tous les deux tours pour repérer cela tôt.",
      },
      {
        title: "Répétez jusqu'à ce que les gains s'arrêtent, et connaissez le vrai coût",
        body: "La plupart des prompts ont une poignée d'améliorations réelles devant eux, puis les tours suivants cessent de faire bouger le score. C'est le signal pour s'arrêter, pas un nombre fixe d'essais. Comptez le temps honnêtement : un tour complet, noter, une révision, noter à nouveau, et une vérification, prend généralement vingt minutes à une heure à la main, donc cinq ou six tours représentent un véritable après-midi, pas une solution rapide.",
      },
    ],
    howBaseline: [
      {
        feature: "Instances figées",
        body: "Vos 10 à 20 cas de test deviennent un ensemble d'instances qui restent fixes pendant toute l'exécution, la même discipline que vous teniez à la main, appliquée automatiquement à chaque fois.",
      },
      {
        feature: "Notation fondée sur une rubrique",
        body: "Vos critères écrits deviennent une rubrique, si bien que chaque essai est noté de la même façon, selon la même norme, sans que vous ayez à remplir la moindre cellule de tableur.",
      },
      {
        feature: "Une exécution d'optimisation explore de nombreuses versions à la fois",
        body: "Au lieu d'une révision ciblée par tour, une exécution d'optimisation teste de nombreuses versions du prompt en parallèle selon la même rubrique et ne garde que celles qui obtiennent un score mesurablement plus élevé.",
      },
      {
        feature: "Un après-midi devient des minutes",
        body: "Toute la recherche, réviser et noter, s'exécute sans surveillance en arrière-plan pendant que votre équipe fait autre chose, puis rend compte avec le prompt gagnant et la preuve à l'appui.",
      },
    ],
    closingLink: {
      label: "Découvrez comment Baseline automatise ce processus",
      href: "/prompt-optimization",
    },
    outcomes: [
      "Obtenez un prompt mesurablement meilleur cette semaine, avec des outils que vous avez déjà.",
      "Transformez un vague sentiment de « mieux » en un score écrit que vous pouvez défendre.",
      "Apprenez exactement quand arrêter l'ajustement manuel et laisser une recherche prendre le relais.",
      "Abordez une exécution automatisée déjà familier du processus qu'elle exécute pour vous.",
    ],
    faqs: [
      {
        question: "ChatGPT ou Claude peuvent-ils vraiment améliorer un prompt ?",
        answer:
          "Oui, pour la partie mécanique. Un assistant compétent peut noter un ensemble de réponses selon des critères fixes, repérer le problème récurrent le plus important, et réécrire le prompt pour le corriger, tour après tour. Ce qu'il ne fera pas de lui-même, c'est rester honnête sur sa propre notation, d'où l'intérêt de garder les cas de test et les critères fixes, et de vérifier son travail vous-même.",
      },
      {
        question: "De combien de cas de test ai-je vraiment besoin ?",
        answer:
          "Peu de cas réels valent mieux que beaucoup de cas inventés. De 10 à 20 entrées tirées d'un usage réel, couvrant les cas qui posent vraiment problème, vous en apprennent plus que 100 exemples synthétiques conçus pour paraître complets. Le réalisme compte plus que le volume.",
      },
      {
        question: "Comment savoir si le nouveau prompt est vraiment meilleur, et pas seulement différent ?",
        answer:
          "Notez-le selon exactement les mêmes cas de test et les mêmes critères que l'original, et notez les deux chiffres. Si le total augmente selon une mesure fixe, l'amélioration est réelle. Si vous ne pouvez pas montrer cette comparaison, vous ne le savez pas encore vraiment.",
      },
      {
        question: "Quand l'optimisation manuelle cesse-t-elle de suffire ?",
        answer:
          "Quand vous répétez la même boucle sur de nombreux prompts, que vous avez besoin que cela se produise selon un calendrier plutôt qu'un après-midi, ou que vous voulez essayer plus de révisions par tour que ce que vous pouvez noter à la main. C'est là qu'une exécution d'optimisation dans Baseline reprend exactement le processus ci-dessus et l'exécute sans surveillance, à une échelle qu'un tableur ne peut pas suivre.",
      },
    ],
  },
};
