# AI AGENTS

Système d'exploitation intelligent de l'entreprise, organisé autour d'un **Agent
Directeur** qui comprend une demande, la planifie, sollicite les agents
spécialisés, lit les données métier et produit une synthèse exploitable.

Le point d'entrée du dirigeant est unique : une conversation en langage naturel
avec le **Director IA**, un vrai agent (modèle OpenAI) qui joue le rôle d'un
directeur général : il reçoit un objectif, mesure l'écart sur les données, bâtit
la stratégie, donne à chaque responsable (Commercial, Marketing, Finance,
Production, Achats…) sa part chiffrée, suit le plan dans le temps et ne fait rien
d'irréversible sans validation humaine. L'exécution — devis, factures, messages —
revient aux responsables.

> **« Je veux qu'on fasse 100 000 DH de chiffre d'affaires ce mois. Quelle stratégie ? »**
>
> **« Qu'est-ce qui risque de bloquer cette semaine et qu'est-ce que je dois décider ? »**

> **Vous installez le projet ?** Suivez [Installation / Passation](#installation--passation)
> juste en dessous. Sans clé OpenAI ni base de données, la
> [démo](#6-démarrage-rapide--demo) démarre aussi en trois commandes.

---

## Installation / Passation

Cette section est le chemin recommandé pour installer le projet sur un poste neuf
(par exemple chez Hiba) et le vérifier. Comptez une vingtaine de minutes.

### Prérequis

- **Node.js 20 ou supérieur** — <https://nodejs.org>, bouton « LTS »
- **Git** — <https://git-scm.com/download/win>
- npm, fourni avec Node.js
- **Une clé API OpenAI** du compte de l'entreprise (§20 du CDC) : c'est elle qui
  fait du Director et des agents de vrais agents IA

Vérifier dans PowerShell :

```powershell
node -v
git --version
```

### Cloner

```powershell
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
cd AI-AGENTS
```

La branche de passation est **`main`** : elle contient le Director conversationnel,
l'équipe d'agents IA, les documents H-KIDS, le suivi des plans et l'import des
données réelles. L'ancienne branche `delivery/hkids-clean` a été intégrée à
`main` et n'est plus la branche de référence.

### Installer

```powershell
npm.cmd ci
```

`npm ci` respecte exactement `package-lock.json` et reproduit l'arbre de
dépendances validé.

### Créer `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Pour démarrer, renseigner :

```env
AUTH_MODE="demo"
PORT="3000"
HOST="127.0.0.1"
OPENAI_API_KEY="<la clé de l'entreprise, jamais commitée ni envoyée>"
```

`.env` est ignoré par Git. Ne jamais écrire de vraie clé, de mot de passe ou de
chaîne de connexion dans `.env.example`, le code ou la documentation.

### Démarrer

**Sur le PC de Hiba : le raccourci « H-KIDS Cockpit » du Bureau.** Un
double-clic récupère la dernière version sur GitHub, installe ce qui manque,
démarre le cockpit et l'ouvre dans le navigateur. Fermer la fenêtre noire
arrête le cockpit. Les raccourcis se créent une fois, après l'installation :

```powershell
npm.cmd run archive:shortcut
```

Ils sont deux : « H-KIDS Cockpit » et « H-KIDS Administratif » (les dossiers
clients). À la main, sans raccourci :

```powershell
npm.cmd start
```

Ouvrir **<http://127.0.0.1:3000/app/>**. Si le port 3000 est déjà pris,
mettre `PORT="3100"` dans `.env`, redémarrer et ouvrir
<http://127.0.0.1:3100/app/>.

> Utiliser `127.0.0.1` plutôt que `localhost` : sur certains postes, une autre
> application écoute le même port sur toutes les adresses et `localhost` peut
> tomber sur elle.

Sans `OPENAI_API_KEY`, le cockpit fonctionne avec l'ancien Director à mots-clés ;
avec la clé, le message d'accueil indique « Director IA connecté ».

### Utiliser le Director

Le Director est un directeur, pas un assistant : il fixe la stratégie et délègue,
les responsables exécutent. On lui écrit dans le **Briefing** :

| Demande | Ce qui se passe |
| --- | --- |
| « Je veux qu'on fasse 100 000 DH de chiffre d'affaires ce mois » | Le Director **mesure** sur les données ce qui est déjà signé, l'écart, le rythme par jour restant et les devis ouverts ; il **bâtit la stratégie** (part des relances, part des nouvelles affaires, panier visé) et donne à chaque responsable **sa part chiffrée** : Commercial (ventes à signer), Marketing (demandes de devis à générer), Production (capacité de l'atelier), Achats (matières), Finance (encaissements). Chacun répond avec son plan ; le Director fait la synthèse, dit si le total couvre l'écart et liste les **décisions** qui reviennent à la direction (offre, budget, remise…). Le plan et la jauge de l'objectif se suivent dans la vue **Plans**. |
| « Où en est l'objectif du mois ? » | Le Director remesure, donne réalisé / cible / écart / rythme, ce qui a bougé et relance les responsables en retard. |
| « Fais un devis pour Meriem à Marrakech, un lit nuage à 3000 DH » | Le Director confie le devis au **Commercial**, qui le prépare (numéro suivant, TVA, 60/20/20 ; prix sans précision = TTC ; prix absent = catalogue). S'il manque une information, le Director la demande. Carte d'aperçu « préparé par Commercial » → **Valider et générer** → PDF + Word. |
| Bon de commande, bon de livraison, facture | Même principe : Commercial pour le BC et le BL, **Finance** pour la facture, qui doit citer son devis ou son BL. Un devis accepté ne fait qu'**une** commande : un second BC sur le même devis est refusé, avec le numéro du premier (le corriger, c'est le remplacer sous son numéro). |
| « Fais le reçu de l'acompte de 2 700 DH par chèque de Mme X, devis 170 » · « Avoir de 600 DH sur la facture 166, à déduire du reste » | **Finance** prépare le **reçu de paiement** (sans TVA, montant en toutes lettres, « pour acquit ») ou l'**avoir** (qui cite sa facture). Jamais plus que le reste à payer de la vente, ni plus que la facture. À la validation : PDF + Word, classés dans le dossier du client (« Reçus de paiement », « Avoirs »), visibles sur le lien de suivi du client, et le dossier de la vente est mis à jour (facturé net des avoirs, déjà reçu, reste à payer). |
| « Combien dois-je encaisser cette semaine ? Prépare les relances » | Le Director délègue à **Finance** (et **Commercial**). Chaque relance devient une **carte WhatsApp** : numéro et texte modifiables, bouton **Envoyer via WhatsApp** qui ouvre WhatsApp pré-rempli. Rien ne part sans le clic d'Hiba. |
| « Qu'est-ce qui risque de bloquer cette semaine ? » | Le Director affiche d'abord un **plan d'action** (objectif, stratégie, priorités, étapes par agent), fait travailler l'équipe, puis signale les **incohérences** entre métiers (production sans acompte, achat avant paiement…). |
| « L'acompte Atlas est arrivé. Où en est le plan ? » | Le Director reprend le plan existant, coche l'étape confirmée, ajoute ce qui est débloqué et donne l'avancement. Les plans se suivent aussi dans la vue **Plans**. |

L'équipe : Commercial, Finance, Production, Achats, Marketing et Community
Manager (le périmètre validé par Hiba), plus RH, SAV et Juridique. Chaque agent ne
lit que ses propres données (§22 du CDC), rédige et propose ; il n'envoie, ne paie
et ne commande jamais rien lui-même.

**Parler au lieu d'écrire.** Le micro du Briefing enregistre : un toucher pour
commencer, un autre pour arrêter (3 minutes au plus). Le serveur transcrit avec
le même modèle que les notes vocales WhatsApp (`OPENAI_TRANSCRIBE_MODEL`, même
clé OpenAI), en français, en arabe ou en darija ; le texte arrive dans la zone
de saisie, à relire avant d'envoyer. L'enregistrement n'est gardé nulle part.
Le navigateur demande l'autorisation du micro la première fois (le site doit
être en HTTPS, ce qu'il est).

**Écrire directement à un agent (§2 du CDC).** Le menu **À** du Briefing choisit
le destinataire : Director par défaut, ou un agent de l'équipe. L'agent répond
lui-même, avec ses outils et ses règles, sans passer par le Director ; chaque
destinataire garde sa propre conversation. Les photos et les documents passent
par le Director, qui les transmet.

**Français, arabe et darija.** On écrit (ou on parle, en note vocale) au Director
en français, en arabe ou en darija, en lettres arabes ou latines (« chhal dkhel f
la caisse lyoum ? »). Il répond en français, ou en darija si la direction n'écrit
qu'en darija. Les messages préparés pour un client suivent sa langue ; les
documents restent en français. Les montants en darija sont le piège : « mlyoun »
vaut 10 000 DH, « 100 alf ryal » 5 000 DH. Le cockpit les repère lui-même
(`src/agent/languages.js`), donne l'équivalent en DH au Director, qui le fait
confirmer avant toute caisse ou tout document ; un « 300 alf » sans unité est
toujours demandé (rials ou dirhams). Sur WhatsApp, l'équipe peut aussi répondre
sur ses tâches en darija : « mohima 4 salat », « ana 3liha, tache 4 »,
« المهمة 4 تقضات ».

### Les fichiers de l'entreprise (`data/`)

Le dossier `data/` est **ignoré par Git** : le dépôt est public, ces fichiers ne
doivent jamais y aller.

| Fichier | Rôle | Modèle |
| --- | --- | --- |
| `data/catalogue-hkids.xlsx` | Produits et prix TTC de base : le Commercial s'en sert quand Hiba ne donne pas le prix, et pour bâtir les ventes d'un objectif. Relu à chaque demande, sans redémarrage. | [`docs/catalogue-hkids.xlsx`](docs/catalogue-hkids.xlsx) |
| `data/plans-director.json` | Les plans d'action du Director, créés et mis à jour automatiquement. | — |
| `data/caisse.json` | Le journal de caisse tenu par le Directeur financier : chaque entrée ou sortie annoncée au Director, d'où viennent le bilan du jour et celui du mois. Un mouvement annulé reste écrit avec son motif. | — |
| `data/justificatifs/` | Les justificatifs des dépenses (photo du reçu, facture PDF), un fichier par pièce, reliés à leur mouvement de caisse. | — |
| `data/amelioration.json` | Les anomalies (étape d'atelier bloquée ou en retard, ou signalée) et les règles proposées par les agents pour qu'elles ne se répètent pas. Une règle ne s'applique qu'une fois validée. | — |
| `data/equipe.json` | Le responsable humain relié à chaque agent et le fil d'équipe (missions, caisse, atelier, documents, comptes rendus reçus par WhatsApp), que chaque agent relit avant de travailler. | — |
| `data/couts-ia.json` | Ce que l'IA a consommé, jour par jour et agent par agent : appels au modèle, jetons, coût estimé. | — |
| `data/whatsapp.json` | Les messages reçus et envoyés par le numéro WhatsApp Business de H-KIDS, et la conversation du Director de chaque numéro de la direction. | — |

Chaque **dépense** passe par quatre états, dans l'ordre (cahier des charges,
section 6) :

1. **déclarée** : annoncée au Director (texte, vocal) ou saisie au cockpit ;
2. **justifiée** : la photo du reçu ou la facture est jointe. Envoyée avec le
   message (« j'ai payé 2 500 DH de MDF, voici le reçu »), Finance la joint
   seule ; sinon l'agent la demande, et elle se joint aussi depuis la vue Caisse ;
3. **approuvée** : par une personne de la direction, dans la vue Caisse, et
   seulement si la dépense atteint le **seuil d'alerte** (2 000 DH par défaut,
   `HKIDS_EXPENSE_ALERT_DH` dans `.env`) ;
4. **rapprochée** : retrouvée sur le relevé de banque ou dans le comptage de la
   caisse. Une dépense rapprochée ne s'annule plus.

Aucun agent ne peut approuver ni rapprocher : ce sont des décisions humaines,
réservées aux comptes qui ont le droit de décider. Le panneau « Dépenses à
régulariser » de la vue Caisse liste ce qui manque, et le Director le rappelle
dans ses points de situation.

Toutes les 30 minutes, le serveur repère les nouvelles anomalies d'atelier et
demande à l'agent concerné d'en chercher la cause (appel à OpenAI). Pour couper
cette analyse automatique : `HKIDS_AUTO_ANALYSIS=off` dans `.env` ; les anomalies
restent alors listées et s'analysent à la demande depuis l'onglet Amélioration.

### Alertes commerciales

En plus des devis à relancer, le cockpit relève sur les documents émis les
alertes commerciales du cahier des charges (V2, section 5). Elles deviennent
des anomalies de l'onglet Amélioration (« Alerte commerciale »), avec un
responsable, une gravité, une tâche possible et leur place dans les
indicateurs du pilote. Celles qui ne sont plus vraies sont levées toutes seules.

| Alerte | Quand | Gravité | Règle à fixer |
| --- | --- | --- | --- |
| Devis expiré | Devis ni commandé ni perdu au-delà de sa validité | moyenne | Validité d'un devis (jours) |
| Remise hors plafond | Devis ou BC dont la remise (lignes et remise globale) dépasse le plafond | haute | Remise maximale sans accord (%) |
| Marge sous le seuil | BC terminé dont la marge, mesurée sur ses dépenses, est sous le minimum (agent Finance) | haute | Marge minimale d'une commande (%) |
| Écart devis / commande | BC dont le montant TTC n'est pas celui de son devis | moyenne | — |
| Client en double | Un même client écrit de plusieurs façons (civilité, accents, ordre des mots) | faible | — |
| Écart commande / facture | BC livré et installé dont les factures, moins leurs avoirs, ne font pas son montant (agent Finance) | moyenne | — |
| Document en double | Deux devis, BC ou factures de même client et même montant à moins de 8 jours (une facture : agent Finance) | moyenne, haute pour une facture | — |
| Dossier incomplet | BC en cours depuis 3 jours sans devis d'origine, montant lisible, date de livraison promise ou chef de charge | moyenne | — |
| Commande non confirmée | BC sans acompte au journal de caisse (sur son numéro ou celui de son devis) au-delà du délai | haute | Confirmation d'une commande (jours) |

- Les quatre règles se fixent dans **Amélioration → Règles commerciales**, par la
  direction seule. Une règle laissée vide ne donne aucune alerte : rien n'est
  supposé à sa place. Elles sont gardées dans `data/relances.json`.
- Une alerte ouverte dit toujours les faits du jour : un dossier complété en
  partie, un montant facturé depuis, un délai qui court mettent son texte à
  jour.
- Une alerte « Marquer réglée » ne revient pas tant que les documents montrent
  le même fait (un nom écrit de deux façons ne s'efface pas).
- Le bilan commercial du Director et de l'agent Commercial les cite, avec les
  règles en vigueur. Une alerte de gravité haute est envoyée à la direction
  par WhatsApp, comme toute anomalie grave.

### Registre de stock

Le registre de stock (CDC V1 section 1, V2 section 9) suit les matières que
l'entreprise garde en stock : ce qui entre, ce qui sort pour chaque bon de
commande, et les inventaires. Il est gardé dans `data/stock.json` et se tient
en parlant au Director, à l'agent Achats ou à l'agent Production :
« livraison de 20 panneaux MDF 18 mm à 300 DH HT », « 6 panneaux sortis pour
le BC 164 », « on a compté 14 panneaux ». L'onglet **Stock** du cockpit le
montre, en lecture.

| Mouvement | Effet sur le stock |
| --- | --- |
| Entrée | Ajoute la quantité livrée ; le prix HT, s'il est dit, entre dans le coût moyen pondéré. |
| Sortie | Retire la quantité, pour un BC (consommation par commande) ou hors commande (casse, perte). Refusée si elle dépasse le stock connu. |
| Inventaire | Note la quantité comptée ; le registre enregistre l'écart. |

- Le stock d'une matière est la somme de ses mouvements, jamais un chiffre
  tapé par-dessus. Une ligne notée par erreur est annulée, pas effacée.
- Le minimum, le fournisseur et son délai sont ceux que dit la direction.
  Une matière sans minimum ne donne jamais d'alerte.
- Une matière au niveau ou sous son minimum devient une alerte de
  l'onglet Amélioration (« Alerte de stock »), confiée à l'agent Achats, avec
  la date d'arrivée si le délai du fournisseur est connu. Plus rien en stock :
  rupture, de gravité haute, envoyée à la direction par WhatsApp. Marquée
  réglée (commande passée), elle ne revient pas avant que la livraison soit
  notée.
- Les outils : `registre_stock` et `mouvement_stock` pour Achats et Production,
  `matiere_stock` et `annuler_mouvement_stock` pour Achats et le Director.

### Budgets

Les budgets (CDC V2 section 6) sont ceux de la direction, comparés aux
dépenses du journal de caisse : rien n'est ressaisi. Ils sont gardés dans
`data/budgets.json` et se fixent dans **Caisse → Budgets → Fixer les budgets**
(direction seule) ou en le disant au Director : « budget transport 3 000 DH par
mois », « pas plus de 12 000 DH de dépenses sur le BC 164 », « garde toujours
20 000 DH en caisse ».

| Budget | Comparé à | Alerte |
| --- | --- | --- |
| Du mois, par catégorie de dépense | Les sorties de la catégorie dans le mois en cours | Budget dépassé (une par catégorie et par mois) |
| D'un bon de commande | Les sorties notées avec son numéro de BC | Budget du BC dépassé |
| Trésorerie minimale | La prévision de trésorerie des 15 prochains jours (encaissements attendus des commandes, dépenses au rythme des 30 derniers jours) | Trésorerie insuffisante ; sans minimum fixé, quand la prévision passe sous zéro |

- Un budget laissé vide n'existe pas et ne donne aucune alerte.
- Les alertes, de gravité haute, deviennent des anomalies de l'onglet
  Amélioration (« Alerte budgétaire ») confiées à l'agent Finance, et partent
  à la direction par WhatsApp. Marquée réglée, une alerte ne revient pas tant
  que la caisse montre le même fait.
- Le budget des salaires reste confidentiel : ses montants ne sont montrés
  qu'à la direction, et son alerte n'en cite aucun.
- Les outils : `budgets` (lecture) pour Finance et le Director, `fixer_budget`
  pour le Director, sur les mots de la direction.

### Capacité de l'atelier

Une date de livraison promise est-elle tenable avec ce que l'atelier a déjà à
faire (CDC V2 sections 5 et 9) ? La direction fixe, pour chaque étape du
parcours, combien de jours ouvrables elle prend pour une commande et combien
de commandes l'équipe y mène en même temps : **Commandes → Charge de l'atelier
→ Durée des étapes** (direction seule), ou au Director : « l'assemblage prend
3 jours, deux commandes à la fois ». Les durées sont gardées dans
`data/capacite-atelier.json`.

- Les commandes en cours sont planifiées l'une après l'autre, la date promise
  la plus proche d'abord, sur les jours ouvrables (lundi à samedi, jours
  fériés du registre RH exclus). Une étape en cours garde sa place pour ce
  qu'il lui reste ; une étape bloquée est comptée comme relancée aujourd'hui.
- Aucune durée n'est inventée : une étape sans durée laisse la fin « non
  estimable » et dit laquelle manque.
- Une date promise plus tôt que la fin estimée devient une anomalie de
  l'onglet Amélioration (« Alerte de planning »), confiée à Production et
  envoyée à la direction par WhatsApp ; elle est levée quand la promesse
  redevient tenable.
- Pour une nouvelle vente, Commercial et Production demandent à l'outil
  `capacite_atelier` (« peut-on livrer avant le 20/12 ? ») : fin estimée, date
  tenable ou non, et les commandes qu'elle ferait manquer. Le Director fixe les
  durées avec `fixer_capacite_atelier`. C'est une estimation, que l'atelier
  confirme avant de promettre.

### Bilan commercial

Le rapport commercial complet (CDC V2 section 5, « Bilans interactifs ») est
dans **Devis → Bilan commercial**, pour la période choisie, et le Director ou
le Commercial le donne avec l'outil `analyse_commerciale`.

- Les totaux : prospects (fiches des réseaux), devis émis, taux de
  transformation, CA commandé (bons de commande), CA facturé (factures, avoirs
  déduits) et CA encaissé (acomptes, soldes et ventes au comptant de la caisse),
  trois chiffres séparés, comparés à la période précédente de même durée.
- L'analyse par produit (l'objet du devis), canal, client, vendeur et campagne ;
  chaque ligne s'ouvre sur ses documents.
- Le canal, le vendeur et la campagne d'une vente sont ceux qu'on dit au
  Director ou au Commercial (« le devis 170 vient d'Instagram, campagne de la
  rentrée, vendu par Nadia » : outil `qualifier_devis`), gardés dans
  `data/relances.json`. Jamais devinés : sans eux, la vente est comptée « non
  renseigné ». Une facture ou un encaissement qui ne se rattache à aucun devis
  du cockpit est compté « non rattaché ».
- L'objectif de CA commandé du mois est fixé par la direction, dans le panneau
  ou au Director (`objectif_commercial`), et comparé aux ventes signées.

### Rapports de la direction

Les rapports programmés (CDC V2 sections 5 et 6) sont composés des livres du
cockpit seulement : documents émis, relances, journal de caisse, carnet
d'atelier, charge de l'atelier, Amélioration et stock. Un chiffre que les
livres n'ont pas est dit manquant, jamais deviné.

| Rapport | Envoyé | Couvre |
| --- | --- | --- |
| Du jour | Chaque matin ouvrable, à partir de 8 h | La veille ouvrable (le lundi : samedi et dimanche) |
| De la semaine | Le premier jour ouvrable de la semaine | Lundi à dimanche précédents |
| Du mois | Le premier jour ouvrable du mois | Le mois précédent |

- Chaque rapport donne les ventes (devis émis, CA commandé, CA facturé moins
  les avoirs, CA encaissé d'après les acomptes, soldes et ventes au comptant de
  la caisse, taux de transformation, devis à relancer), la caisse (entrées,
  sorties, solde), l'atelier (commandes en cours,
  livrées, en retard, bloquées, dates promises intenables) et ce qui reste à
  traiter (anomalies, tâches en retard, stock, budgets, justificatifs manquants). Un salaire est compté
  dans les totaux, jamais nommé.
- Il est gardé dans `data/rapports.json` et visible dans **Briefing → Rapports
  de la direction** (direction seule), et envoyé à la direction sur WhatsApp
  quand le numéro est connecté ; jamais deux fois pour la même période.
- La direction active ou arrête chaque rapport, et peut en voir un tout de
  suite sans l'envoyer (« Voir maintenant »), ou le demander au Director
  (outil `rapport_periodique`).

### Indicateurs du pilote

En tête de l'onglet Amélioration, le panneau « Indicateurs du pilote » donne
les sept chiffres que l'annexe V2 du cahier des charges demande de suivre
pendant 30 à 60 jours. Ils sont comptés sur la période choisie, à partir des
carnets du cockpit ; un tiret veut dire qu'il n'y a rien à compter.

| Indicateur | Ce qui est compté |
| --- | --- |
| Commandes en retard | Commandes suivies sur la période (en cours, ou finies dedans) dont une étape a fini après sa date prévue ou la dépasse. |
| Délai moyen de résolution | De la détection d'une anomalie à sa levée (clôture confirmée, ou carnet d'atelier revenu à la normale). |
| Anomalies détectées | Par type et gravité, hors fausses alertes. |
| Procédures approuvées | Règles proposées sur la période : validées sur validées + refusées. Une règle retirée plus tard avait été validée. |
| Incidents récurrents | Anomalies revenues alors que la règle qui devait l'empêcher était en vigueur. |
| Temps administratif économisé | Missions confiées aux agents × minutes gagnées par mission (`HKIDS_PILOT_MINUTES_PER_MISSION`, une hypothèse de la direction). Sans elle, seul le nombre de missions est donné. |
| Fausses alertes | Anomalies que la direction a marquées « Fausse alerte », sur toutes celles détectées. |

- La période par défaut va de `HKIDS_PILOT_START` (AAAA-MM-JJ, le premier jour
  du pilote) à aujourd'hui, ou couvre les 30 derniers jours sans ce réglage.
- « Fausse alerte » (direction seule, avec une raison) sort l'anomalie de la
  liste et ferme sa tâche. Tant que le carnet d'atelier montre le même fait,
  elle ne revient pas ; si le fait disparaît puis revient, c'est une nouvelle
  anomalie.
- Le nombre de missions est gardé jour par jour dans `data/equipe.json`, au-delà
  des dernières lignes du fil de l'équipe.

### WhatsApp Business

Le cockpit se branche sur l'**API officielle WhatsApp Business** (Cloud API de
Meta), comme le demande la phase 1 du cahier des charges. Ce que fait chaque
message écrit au numéro de H-KIDS dépend de qui l'écrit :

| Qui écrit | Ce qui se passe |
| --- | --- |
| La direction (`WHATSAPP_OWNER_NUMBERS`) | Le message va au **Director**, comme s'il était tapé dans le cockpit, et sa réponse part sur WhatsApp **avec ses fichiers** : un document retrouvé au registre (trois au plus), un PDF ou un fichier Excel qu'il a fait. Un document préparé (devis, bon de commande, facture…) arrive en **aperçu PDF** barré « APERÇU — NON VALIDÉ » ; la direction répond **« valide »** (ou « valide 172 ») pour le générer et reçoit le PDF définitif, **« annule »** pour l'abandonner. Un message préparé pour un client dont le numéro est connu part quand elle répond **« envoie »**. Rien n'est généré ni envoyé sans ce mot ; ce qui attend est gardé 48 heures. Les décisions sensibles (dépense à approuver, fichier CNC, règle, clôture) restent dans le cockpit. |
| Un responsable relié à un agent (vue Équipe) | C'est un **compte rendu** : il entre dans le fil d'équipe, que lisent le Director et l'agent concerné, et un accusé de réception part. Ce n'est jamais un ordre. |
| Toute autre personne (client, fournisseur) | Le message attend dans la vue **WhatsApp** du cockpit. Personne ne répond automatiquement : une personne répond depuis le cockpit. |

Les messages préparés par les agents gardent leur validation humaine : le bouton
« Envoyer depuis le numéro H-KIDS » du cockpit, ou le mot « envoie » de la
direction sur WhatsApp, les envoie tels que relus. WhatsApp n'autorise
un message libre que dans les **24 heures** qui suivent le dernier message de la
personne ; au-delà, Meta exige un modèle approuvé. Le cockpit le dit, et le
bouton « Ouvrir dans WhatsApp » reste disponible pour ce cas.

Mise en route, une fois :

1. Sur [developers.facebook.com](https://developers.facebook.com), créer une
   application de type *Business* et y ajouter le produit **WhatsApp**. Relier le
   numéro dédié à H-KIDS (un numéro qui n'est pas déjà utilisé dans l'application
   WhatsApp).
2. Dans `.env`, remplir `WHATSAPP_PHONE_NUMBER_ID` (identifiant du numéro),
   `WHATSAPP_ACCESS_TOKEN` (jeton permanent d'un utilisateur système),
   `WHATSAPP_APP_SECRET` (Paramètres de l'application → Général),
   `WHATSAPP_VERIFY_TOKEN` (une longue chaîne au choix) et
   `WHATSAPP_OWNER_NUMBERS`.
3. Le serveur doit être joignable en **HTTPS** depuis internet (voir `deploy/`).
   Dans Meta → WhatsApp → Configuration, donner comme URL de rappel (*Callback
   URL*) `https://<votre-domaine>/webhooks/whatsapp` (la vue WhatsApp du cockpit
   l'affiche), le même `WHATSAPP_VERIFY_TOKEN`, puis s'abonner au champ
   **messages**.

Chaque appel de Meta est vérifié avec la signature faite à partir de
`WHATSAPP_APP_SECRET` ; un appel non signé est refusé.

Ce que le Director lit en plus du texte, quand c'est la direction qui écrit :

- les **messages vocaux**, transcrits par OpenAI (même clé `OPENAI_API_KEY`,
  modèle `OPENAI_TRANSCRIBE_MODEL`, `gpt-4o-transcribe` par défaut). Sa réponse
  commence par « J'ai entendu : « … » », pour qu'un mot mal compris se voie tout
  de suite. Les vocaux de l'équipe sont transcrits dans leur compte rendu ;
- les **photos** JPEG ou PNG (3 Mo au plus) et les **documents** PDF, Word, Excel,
  texte ou CSV (5 Mo au plus), comme s'ils étaient joints dans le cockpit.

Les vidéos et autocollants ne sont pas lus. Les vocaux d'un client ne sont pas
transcrits : ils attendent dans la vue WhatsApp, comme ses autres messages.

Les dossiers réels (clients, devis, commandes, paiements, achats) se chargent dans
la base avec le classeur [`docs/modele-donnees-hkids.xlsx`](docs/modele-donnees-hkids.xlsx) :
voir [Importer les données réelles H-KIDS](#importer-les-données-réelles-h-kids).
Tant qu'ils ne sont pas importés, les agents travaillent sur des **données de
démonstration** et le disent.

### Instagram et Facebook

La Page Facebook H-KIDS et le compte Instagram professionnel qui lui est relié
passent par l'API officielle de Meta (Graph API). Le parcours du cahier des
charges : message Instagram → Community Manager → fiche prospect → Commercial →
devis.

- Les **messages privés** et les **commentaires** reçus arrivent par le webhook
  `/webhooks/meta`, sans doublon, dans `data/reseaux.json`.
- Le **Community Manager** les lit (`boite_reseaux`) et prépare la réponse
  (`preparer_reponse_reseaux`). Il crée la **fiche prospect** P-001, P-002…
  (`fiche_prospect`) d'une personne qui demande un prix ou un devis, puis la
  transmet au **Commercial** (`transmettre_prospect`).
- Le **Marketing** et le CM préparent les **publications** pour un jour et une
  heure du Maroc (`preparer_publication`). Instagram exige une photo à une
  adresse publique https (JPEG). Ils lisent les chiffres réels :
  `statistiques_reseaux` donne les abonnés, likes et commentaires.
- **Rien ne part sans la direction.** Chaque réponse et chaque publication
  arrive dans « À valider ». « Approuver » envoie la réponse. Une publication
  approuvée part à son heure : le serveur vérifie chaque minute.

Meta n'autorise une réponse en message privé que dans les **24 heures** qui
suivent le dernier message de la personne. Au-delà, le cockpit marque la réponse
« non envoyée » avec la raison.

Mise en route, une fois :

1. Relier le compte Instagram professionnel à la Page Facebook H-KIDS (dans les
   paramètres du compte Instagram ou de la Page).
2. Sur [developers.facebook.com](https://developers.facebook.com), dans
   l'application de l'entreprise, ajouter les produits **Instagram** (API avec
   connexion Facebook) et **Messenger**. Demander les autorisations :
   - `pages_show_list`, `pages_manage_metadata`, `pages_messaging` ;
   - `pages_read_engagement`, `pages_read_user_engagement` ;
   - `pages_manage_posts`, `pages_manage_engagement` ;
   - `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`,
     `instagram_content_publish`.

   Hors mode développement, Meta les accorde après examen de l'application
   (*App Review*).
3. Dans `.env`, remplir :
   - `META_PAGE_ID` ;
   - `META_PAGE_ACCESS_TOKEN` : un jeton de Page longue durée, d'un utilisateur
     système du portefeuille ;
   - `META_INSTAGRAM_ID` : l'identifiant du compte Instagram professionnel ;
   - `META_APP_SECRET` ;
   - `META_VERIFY_TOKEN` : une longue chaîne au choix.
4. Dans Webhooks, déclarer l'URL de rappel `https://<votre-domaine>/webhooks/meta`
   avec le même `META_VERIFY_TOKEN`. Abonner l'objet **Page** aux champs
   `messages` et `feed`, et l'objet **Instagram** aux champs `messages` et
   `comments`.

Sans ces clés, tout fonctionne dans le cockpit (boîte, prospects, publications à
valider), mais rien n'est envoyé.

### Régler les agents sans programmer

Dans **Équipe IA**, chaque agent a son bloc « Réglages de l'agent ». La
direction seule peut le modifier (rôle `leader`). Il contient :

- **Consignes de la direction** : un texte que l'agent lit avant chaque
  mission, par exemple « toujours proposer la livraison et le montage ». Elles
  ne lèvent jamais une règle de sécurité ou de validation.
- **Ton des réponses** : par défaut, formel, chaleureux, concis ou
  pédagogique. L'agent le lit avant chaque mission.
- **Outils** : chaque outil est **autorisé**, en **validation requise** ou
  **interdit**, dès la prochaine mission. Deux outils restent toujours actifs :
  `documents_reference` et `memoriser`.
  - Un outil interdit est retiré à l'agent.
  - Un outil en validation requise ne s'exécute pas quand l'agent l'appelle.
    L'action est gardée avec ce qu'elle ferait, et l'agent dit qu'elle attend
    votre accord. Elle apparaît en haut d'**Équipe IA** (« Actions à valider »).
    Validée, elle s'exécute aussitôt sur les livres tels qu'ils sont ; refusée,
    jamais.
  - Seuls les outils qui écrivent dans les livres du cockpit (caisse, stock,
    RH, registre administratif, budgets…) peuvent passer en validation. Les
    documents, les messages et les publications ont déjà leur propre
    validation.
- **Documents de référence** : catalogue, grille tarifaire, procédure, fiche
  technique, en PDF, Word (.docx), Excel (.xlsx), texte ou CSV, 8 Mo au plus.
  - Le texte est lu une fois, à l'import. Un PDF est lu par l'IA
    (`OPENAI_API_KEY`). « Voir ce que l'agent lit » montre ce qui a été retenu.
  - L'agent y cherche avec `documents_reference`. Il cite la source (titre et
    version). La recherche lit des mots entiers (« lit » ne trouve pas
    « politique »), au singulier comme au pluriel. Elle connaît les synonymes
    du métier (armoire, placard, dressing ; prix, tarif ; pose, montage). Un
    mot rare pèse plus qu'un mot présent partout. Les mots de la question côte
    à côte (« lit cabane ») font passer le bon passage devant.
  - Importer un document sous le même titre crée la **version suivante** et
    rend l'ancienne **périmée**. Un document périmé ne sert plus que
    d'historique.
  - Si deux documents en vigueur se contredisent, l'agent ne choisit pas : il
    pose la question à la direction.
- **Mémoire de travail** : les notes que l'agent garde d'une mission à l'autre
  (`memoriser`, 40 au plus par agent). La direction peut en effacer une.
- **Indicateurs sur 30 jours**, en tête du bloc :
  - les missions reçues et les actions notées au fil ;
  - les anomalies qui lui sont confiées, ouvertes et levées ;
  - les actions qui attendent votre validation ;
  - les tests de réponses réussis.
- **Tests de réponses** : une question type, les mots que la réponse doit
  contenir et ceux qu'elle ne doit pas contenir (20 tests au plus par agent).
  - « Lancer » interroge l'agent en **mode test** : il lit ses données, mais
    rien de ce qu'il voudrait enregistrer ne l'est.
  - La réponse est comparée sans tenir compte des accents ni des majuscules.
    Le résultat garde la réponse obtenue et les mots manquants ou trouvés.
  - Chaque lancement est un vrai appel à l'IA, compté dans son coût.

Les réglages sont gardés dans `data/agents.json`, et le texte des documents
dans `data/agents-documents/`.

### La bibliothèque d'agents (une équipe par métier)

Une entreprise cliente reçoit l'équipe de son métier, choisie à la création
(`tenant.sh create … --modele=…`, gardée dans `HKIDS_TEAM_TEMPLATE`). Les
modèles sont dans `src/agent/team-templates.js` :

| Modèle | Pour | Agents essentiels (Starter) |
| --- | --- | --- |
| `fabricant` | atelier, fabrication sur commande (H-KIDS) | Commercial, Finance, Production, Administration |
| `commerce` | boutique, vente en ligne | Commercial, Finance, Achats, Administration |
| `restaurant` | restaurant, traiteur | Finance, Achats, RH, Marketing |
| `services` | prestations, interventions | Commercial, Finance, RH, Administration |
| `agence` | communication, immobilier, voyage… | Commercial, Finance, Marketing, Administration |

- L'offre ouvre : **Starter** les agents essentiels du modèle (4 au plus),
  **Business** toute l'équipe du modèle, **Enterprise** toute la bibliothèque.
  H-KIDS, le pilote, garde toute son équipe.
- Dans **Équipe IA**, la direction active ou retire un agent dans cette
  limite. Un agent hors équipe reste visible, grisé, avec l'offre qui l'ouvre.
  Les dessinateurs travaillent sous Production et le Community Manager sous
  Marketing : on ne peut pas activer l'un sans l'autre.
- Le Director ne délègue qu'à l'équipe active ; une mission confiée à un agent
  hors équipe est refusée sans appeler l'IA. Hors `fabricant`, le Director et
  chaque agent savent le métier de l'entreprise (pas d'atelier ni de CNC).
- Un modèle inconnu dans `HKIDS_TEAM_TEMPLATE` empêche le cockpit de démarrer,
  avec la liste des modèles.

### Automatisations « quand … alors … »

En bas de **Équipe IA**, le panneau **Automatisations** permet à la direction
d'écrire ses propres règles sans programmer. La direction seule les crée, les
met en pause ou les supprime (rôle `leader`) ; l'équipe les lit. On peut aussi
les dire au Director, dans le cockpit ou sur WhatsApp : « quand un devis est
accepté, préviens la production ». Il utilise alors `creer_automatisation`.

Une règle se compose de trois parties :

- **Un événement.**
  - Documents émis : devis, bon de commande (« devis accepté »), facture, bon
    de livraison, avoir, reçu de paiement.
  - Caisse : encaissement ou dépense. Les dépenses confidentielles ne
    déclenchent rien.
  - Atelier : étape terminée, étape bloquée ou étape en retard.
  - Bon de livraison signé par le client.
  - Prospect transmis par le Community Manager.
- **Des filtres facultatifs** : un montant minimum, une étape d'atelier, ou un
  mot contenu dans l'événement.
- **Une à cinq actions**, chacune immédiate ou décalée de quelques jours.
  - Prévenir un agent, dans le fil de l'équipe.
  - Confier une mission à un agent. Il ne génère rien de définitif et n'écrit à
    aucun client.
  - Écrire à la direction sur WhatsApp.
  - Donner une tâche à la personne reliée à un agent, sur WhatsApp, avec une
    échéance.

Les textes peuvent citer l'événement entre accolades : `{numero}`, `{client}`,
`{montant}`, `{commande}`, `{etape}`… Le bouton « Partir de l'exemple » remplit
l'exemple du cahier des charges : devis accepté, puis production prévenue,
mission aux achats et rappel de paiement à 30 jours.

Fonctionnement :

- Les actions décalées attendent leur jour. Le serveur les vérifie toutes les
  5 minutes.
- Une règle mise en pause ou supprimée annule ses actions en attente.
- Une règle s'arrête d'elle-même après 20 déclenchements dans la même journée.
- Chaque exécution, réussie ou non, est listée dans « Dernières exécutions ».
- Tout est gardé dans `data/automatisations.json`.

### Analyse : rentabilité et prévision de trésorerie

Le Director et l'agent Finance répondent à « quels produits sont les plus
rentables ? » et « quelle trésorerie dans 15 jours ? » à partir du cockpit,
jamais d'une estimation.

- **`rentabilite`** (période, 3 derniers mois par défaut) :
  - Marge de chaque bon de commande : vente HT (TTC / 1,2) moins les dépenses
    de caisse rattachées au BC ou à son devis.
  - Puis la marge par produit (objet du BC), et les charges non rattachées
    (loyer, salaires…).
  - Un BC sans dépense rattachée est listé à part : sa marge n'est pas
    mesurable. Pour la mesurer, noter le numéro du BC sur chaque achat.
- **`prevision_tresorerie`** (1 à 90 jours, 15 par défaut) :
  - Part du solde de caisse du jour.
  - Ajoute les encaissements attendus selon l'échéancier standard : acompte
    non reçu, part due à la livraison prévue au carnet d'atelier, solde des
    commandes installées.
  - Retire les dépenses au rythme des 30 derniers jours.
  - Donne le solde prévu, le point bas et le premier jour négatif.

Rien n'est enregistré : ce sont des lectures.

### Équipe RH : congés, présences, variables de paie

La vue **Équipe RH** du cockpit montre :

- les salariés et leur solde de congés (Code du travail, art. 231 à 233) :
  - 1,5 jour ouvrable par mois de service, plus 1,5 jour par tranche de
    5 ans d'ancienneté, 30 jours au plus ;
  - rien n'est dû avant 6 mois de service ;
  - les jours ouvrables vont du lundi au samedi, jours fériés exclus ;
- les demandes de congé en attente ;
- les absences, retards et heures supplémentaires du mois ;
- les variables de paie du mois, à transmettre au comptable.

Ce sont des variables, pas une paie calculée.

Ce qu'on peut dire au Director ou à l'agent RH : « Karim absent hier,
malade », « Sara demande 5 jours à partir du 2 décembre », « variables de paie
de novembre ». La direction seule accepte ou refuse un congé : dans la vue, ou
au Director. L'agent RH ne décide d'aucun congé.

Le motif d'une absence n'est montré qu'à qui voit le confidentiel (loi 09-08).
Tout est gardé dans `data/rh.json`.

### Contrats, recrutement et formations

Le même carnet garde aussi, sur ce que la direction dit au Director ou à
l'agent RH :

- **les contrats** (outil `contrat_salarie`) : CDI, CDD, contrat d'insertion
  ANAPEC ou stage, avec leurs dates.
  - Un nouveau contrat remplace celui en cours (renouvellement, passage en CDI).
  - La période d'essai est celle que la direction donne. Sinon, c'est celle de
    l'art. 14 du Code du travail :
    - pour un CDI : 3 mois (cadre), 1 mois et demi (employé), 15 jours (ouvrier) ;
    - pour un CDD : 1 jour par semaine, 2 semaines au plus, sous 6 mois ;
      1 mois au-delà.
  - Seules les dates sont gardées, jamais le salaire : le contrat signé fait foi.
- **le recrutement** (outil `recrutement`) : postes ouverts, candidatures,
  entretiens, puis embauche.
  - Un candidat embauché rejoint l'équipe et son poste est pourvu.
  - Du candidat, on ne garde que le nom, le numéro WhatsApp, la provenance et
    une courte note (loi 09-08).
  - Ses données s'effacent sur demande, ou 12 mois après la clôture du poste.
- **les formations** (outil `formation`) : planifiées, réalisées ou annulées,
  avec leur date de fin de validité s'il y en a une.

Les contrats et les candidatures sont réservés à la direction. Les autres
voient les postes ouverts et les formations.

Les alertes RH remontent dans **Amélioration**, confiées à l'agent RH :

| Alerte | Quand | Gravité |
| --- | --- | --- |
| Fin de contrat | un CDD, un contrat ANAPEC ou un stage finit dans les 30 jours, ou est fini alors que le salarié est toujours là | haute à 7 jours ou moins, sinon moyenne |
| Fin de période d'essai | dans les 7 jours | moyenne |
| Formation à renouveler | sa validité finit dans les 30 jours, sans nouvelle session prévue | moyenne |
| Données de candidats | des candidatures de postes clos depuis plus de 12 mois | faible |

Une alerte disparaît d'elle-même quand le carnet ne la montre plus : un
contrat renouvelé, une session planifiée, des données effacées.

### Abonnements : facturer les entreprises clientes

Le cockpit qui vend les abonnements (celui de H-KIDS, sans `HKIDS_PLAN`) a une
vue **Abonnements**, visible de la direction seule :

- les entreprises clientes : nom légal, adresse du siège, offre, prix HT par
  mois (celui de l'offre par défaut) ;
- le revenu mensuel et annuel, l'encaissé, le retard ;
- chaque 1er du mois, une facture préparée par entreprise active. La direction
  voit le numéro et le montant, puis émet : c'est une facture H-KIDS ordinaire,
  dans sa série, qui cite « Référence abonnement : ABO-&lt;entreprise&gt; » au lieu
  d'un devis ou d'un BL, avec TVA 20 % et une échéance à 30 jours ;
- les impayés, avec une relance prête à copier à J+7 et J+15 après
  l'échéance, envoyée par la direction elle-même ;
- au-delà de 30 jours de retard, la suspension proposée avec sa commande :
  `sh scripts/tenant.sh suspend <entreprise>` met son cockpit en lecture seule,
  ses données restent consultables et exportables ; `resume` le réactive.

Rien n'est émis, envoyé ou suspendu seul. Le paiement est noté à réception du
virement (« Virement reçu »). Tout est gardé dans `data/abonnements.json`.

### Pack du comptable

Chaque mois, la direction télécharge pour le comptable un seul fichier ZIP :
**Caisse → Pack du comptable**, mois au choix (le mois précédent par défaut),
route `GET /api/accounting/pack?month=AAAA-MM`. Direction seule : le pack
contient les dépenses confidentielles et les absences de l'équipe.

| Fichier | Contenu |
| --- | --- |
| `ecritures.xlsx` | Les écritures proposées sur les comptes du CGNC (voir `export_comptable`) |
| `ventes.xlsx` | Factures et avoirs du mois : HT, TVA facturée, TTC, avoirs déduits |
| `caisse-banque.xlsx` | Encaissements et dépenses, avec le nom de leur justificatif ou « manquant » |
| `variables-paie.xlsx` | Jours, absences, congés, retards et heures supplémentaires, sans montant (s'il y a des salariés) |
| `pieces/` | PDF des factures, avoirs et reçus de paiement du mois |
| `justificatifs/` | Reçus et factures fournisseurs joints aux dépenses |
| `LISEZ-MOI.txt` | Les totaux du mois et ce qui reste à compléter : facture sans contenu gardé, PDF absent, dépense sans justificatif (hors salaires) |

Rien n'est inventé : les comptes sont une proposition, la TVA est celle des
factures ; la TVA due et la TVA récupérable sur les achats se calculent par le
comptable sur les pièces. Le téléchargement est noté au journal d'audit.

### Double authentification obligatoire pour la direction

En production, un compte de la direction (qui voit les données confidentielles)
n'ouvre rien tant que la double authentification n'est pas activée : à la
connexion, la fenêtre « Sécurité du compte » s'ouvre seule (QR code à scanner
avec Google ou Microsoft Authenticator, code à 6 chiffres, dix codes de
secours), et le cockpit se charge ensuite. Elle ne se désactive pas pour la
direction. Les autres comptes la choisissent eux-mêmes. Réglage :
`DIRECTION_TWO_FACTOR` (vide = obligatoire en production ; `required` ou `off`).

### Loi 09-08 : la mention sur les données personnelles

Chaque document client (devis, BC, BL, facture, avoir, reçu, en PDF et en
Word), la page de suivi du client, la feuille de signature du BL et la
**première** réponse privée Instagram / Facebook à une personne portent la
mention : qui traite ses données, pour quoi, et l'adresse où exercer ses droits
d'accès, de rectification et d'opposition. Une réponse publique sous un
commentaire ne la porte pas ; une réponse refusée par la direction ne compte pas.
Deux réglages du `.env` la complètent, et n'apparaissent qu'une fois remplis :
`CNDP_NUMBER` (le numéro du récépissé de la CNDP) et `DATA_HOSTING_COUNTRY`
(le pays où le serveur est hébergé).

### Données de l'entreprise : export et suppression

- **Export.** La direction télécharge toutes les données de son entreprise dans
  un fichier ZIP : fenêtre **Sécurité du compte** (bouclier en haut), section
  « Données de l'entreprise » (route `GET /api/company/export`).
  - Le ZIP contient les registres en JSON (`donnees/`), chaque document émis en
    PDF, Word et JSON (`documents/`), les copies classées (`classement/`) et le
    journal d'audit.
  - Il ne contient ni mot de passe, ni code de double authentification, ni clé
    de service ; un fichier `.env` ou `.key` laissé dans `data/` est écarté.
  - L'export marche aussi pendant une suspension, et il est noté au journal
    d'audit. Un autre compte que la direction est refusé.
- **Suppression.** Seul le fournisseur supprime une entreprise, avec
  `sh scripts/tenant.sh delete` et ses trois verrous : l'entreprise est
  arrêtée, un export de moins de 7 jours existe et lui a été remis, et
  l'identifiant est retapé. Voir `docs/DEPLOIEMENT-ORACLE.md`.

### E-mail

Un message ou un document part de l'adresse de l'entreprise, par son propre
serveur d'e-mail (SMTP), une fois que quelqu'un a cliqué « Envoyer » dans le
cockpit. Aucun agent n'envoie d'e-mail seul.

- **Réglages** dans `.env` : `SMTP_HOST`, `SMTP_PORT` (587 ou 465),
  `SMTP_USER`, `SMTP_PASSWORD`, et au besoin `SMTP_FROM` (par défaut
  `COMPANY_EMAIL`) et `SMTP_FROM_NAME`. Pour Gmail, il faut un « mot de passe
  d'application ». Sans `SMTP_HOST`, rien ne part par e-mail.
- **Chiffrement.** La connexion est toujours chiffrée : TLS dès le départ
  (port 465) ou STARTTLS (port 587). Un serveur qui n'offre pas de chiffrement
  est refusé, sauf `SMTP_SECURE=none` pour un serveur sur la même machine.
- **Envoyer un document** : vue Documents, registre, « Envoyer par e-mail » sur
  la ligne du document. On relit l'adresse, l'objet et le message ; le PDF est
  joint.
- **Envoyer un message préparé par un agent** : sous la carte du message,
  « Envoyer plutôt par e-mail ».
- Chaque envoi, réussi ou en échec avec sa raison, est gardé dans
  `data/emails.json`, écrit dans le fil de l'équipe et noté au journal d'audit.

La réception d'e-mails (lire une boîte) n'est pas branchée : les réponses des
clients arrivent dans la boîte habituelle de l'entreprise.

### Application installable

Le cockpit s'installe comme une application, sur téléphone ou sur ordinateur :

- Android / Chrome : menu, puis « Installer l'application ».
- iPhone / Safari : Partager, puis « Sur l'écran d'accueil ».

Il s'ouvre alors en plein écran avec son icône (`/manifest.webmanifest`). Il
n'y a pas de mode hors ligne : le cockpit a besoin du serveur.

### Documents H-KIDS

Toutes les pièces H-KIDS — **devis, bon de commande, facture et bon de livraison** —
sont dessinées par le code, dans le design adopté avec les bons de commande :
logo et adresse du registre (DOUAR HARAKAT N 2153 TASSELTANT SAADA MARRAKECH),
tableau à en-tête vert, totaux sur bandeau vert, conditions de règlement, puis
selon la pièce un bloc « Bon pour accord » ou « Réception de la livraison ».
**Aucun gabarit n'est à fournir.** Les fichiers générés vont dans
`assets/documents/generated/`, ignoré par Git.

### Dossiers clients et registre (l'Administratif)

Chaque devis, bon de commande, bon de livraison et facture est aussi **classé
en PDF dans le dossier de son client**, la date au début du nom :

```
Documents\H-KIDS Administratif\
  BARADA\Devis\2026-11-10_devis_171.pdf
  BENCHAKROUN\Factures\2026-09-05_facture_165.pdf
  Registre des documents.csv        ← s'ouvre dans Excel
```

- Le classement se fait **à chaque document validé**, au démarrage et toutes
  les demi-heures. Il **copie** sans rien déplacer et sans doublon : relancé, il
  ne recopie que ce qui est nouveau. Les numéros restent ceux des documents.
- **Importer l'existant** : déposez les anciens devis et factures dans
  `assets/documents/generated/` (avec leur `.json` ou leur `.docx`), puis
  cliquez « Classer maintenant » dans **Documents**. Le cockpit dit combien sont
  classés, déjà en place, et quels PDF manquent.
- **Retrouver un document** : le panneau « Registre des documents » (vue
  Documents) cherche par client, numéro, type ou dates, avec un bouton
  « Ouvrir le PDF ». Au Director : « Ressors-moi le devis de Mme Barada » — il
  répond avec le document et son bouton ; s'il y en a plusieurs, il liste les
  dates et les numéros pour que vous choisissiez. L'agent **Administratif** fait
  la même recherche quand le Director lui confie une mission.
- **Tableaux et Excel** : le Director répond en tableau quand on le lui
  demande (« fais-moi un tableau des devis du mois »). « Exporte-le en Excel »
  donne un fichier `.xlsx` avec un bouton « Télécharger » sous la réponse,
  rangé aussi dans `H-KIDS Administratif\Exports`. Montants, dates et
  pourcentages y sont de vrais nombres ; la ligne Total est une formule. Le
  registre a aussi son bouton « Exporter en Excel ».
- **Raccourci sur le Bureau** (une fois, sur le PC de Hiba) :

  ```powershell
  npm run archive:shortcut
  ```

  Le dossier est `Documents\H-KIDS Administratif` ; `HKIDS_ARCHIVE_DIR` dans
  `.env` en choisit un autre (un dossier OneDrive ou partagé, par exemple).

### Registre administratif : fournisseurs, contrats, échéances, courriers

La vue **Administratif** du cockpit montre le reste du travail de
l'Administratif, en plus des documents émis. On le tient en le disant au
Director ou à l'agent Administratif.

- **Fournisseurs** (outil `fournisseur`) : leur activité, leur contact, leurs
  conditions, et l'ICE s'il est donné (15 chiffres, vérifié). Rien n'est
  supposé : un téléphone ou un e-mail non dit reste vide.
- **Contrats de l'entreprise** (outil `contrat_entreprise`) : bail, assurance,
  leasing, maintenance, abonnement, contrat fournisseur ou client.
  - On note les dates, la durée, le renouvellement (tacite, à décider, aucun)
    et le préavis.
  - Un contrat à reconduction tacite avance d'une période à chaque échéance.
    Le registre donne la dernière date pour le résilier.
  - Les montants ne sont montrés qu'à la direction, et seule la direction
    enregistre un contrat.
- **Échéances** (outil `echeance`) : fiscales, CNSS, assurance, loyer, banque…
  - Une échéance arrive une fois, ou chaque mois, trimestre ou année.
  - Dite faite, une échéance récurrente passe à sa date suivante.
  - On les confirme avec le comptable : l'agent les rappelle, il ne déclare
    rien.
- **Courriers** (outil `courrier`) : chaque courrier reçu ou envoyé prend un
  numéro chrono de l'année (2026-001).
  - Un courrier reçu peut attendre une réponse avant une date.
  - Un courrier à envoyer est rédigé par l'agent et gardé en **brouillon**.
    La direction le lit dans la vue avec l'en-tête de l'entreprise, le copie,
    l'envoie elle-même, puis le note envoyé.
  - Un courrier envoyé en réponse règle le courrier reçu.

Les alertes remontent dans **Amélioration** :

| Alerte | Quand | Gravité | Confiée à |
| --- | --- | --- | --- |
| Échéance proche | dans le délai de rappel (7 jours par défaut) | haute à 2 jours ou moins, sinon moyenne | Finance (fiscale, sociale, banque), sinon Administratif |
| Échéance dépassée | la date est passée | haute | idem |
| Préavis de contrat | la dernière date pour résilier un contrat tacite est dans les 30 jours | haute à 7 jours ou moins, sinon moyenne | Administratif |
| Fin de contrat | un contrat sans reconduction tacite finit dans les 30 jours | haute à 7 jours ou moins, sinon moyenne | Administratif |
| Courrier à traiter | la réponse est attendue dans 3 jours ou moins, ou en retard | haute en retard, sinon moyenne | Administratif |

Tout est gardé dans `data/administratif.json`.

### Réserves à la livraison

Le client signe son bon de livraison sur son lien de suivi. Il peut cocher
« Je signe avec des réserves » et les écrire (1 000 caractères au plus) :
élément manquant, abîmé ou non conforme.

- Le bon signé les reprend mot pour mot : « reconnais avoir reçu … sous les
  réserves suivantes, écrites par moi avant de signer ». Sans réserve, la
  phrase reste « en bon état apparent ».
- La direction est prévenue sur WhatsApp et dans le fil de l'équipe, avec le
  texte des réserves.
- Une réserve dite autrement (sur le bon papier, au téléphone) est notée par
  l'équipe : dans la carte de la commande (vue Atelier, panneau « Réserves de
  livraison »), ou au Director et aux agents SAV et Production (outil
  `reserve_livraison`).
- Une réserve ouverte est une anomalie **haute** confiée au **SAV** dans
  **Amélioration**, et une alerte de la commande au carnet d'atelier.
- On la lève en disant ce qui a été fait ; l'anomalie est alors levée. Le
  client voit sur son lien chaque réserve et si elle est levée, jamais la note
  de l'équipe.

---

## 1. Présentation

L'objectif n'est pas de juxtaposer des chatbots indépendants, mais de construire
une équipe organisée où :

- le dirigeant s'adresse **au Directeur uniquement**, jamais à chaque agent ;
- le Directeur détermine quels agents solliciter et dans quel ordre ;
- chaque agent n'accède qu'aux informations nécessaires à sa mission ;
- les actions sensibles sont **préparées, puis soumises à validation humaine** ;
- les données métier de l'entreprise sont la source de vérité, pas l'historique
  de conversation.

Le but n'est pas de remplacer l'équipe humaine. L'IA gère l'information,
surveille les processus, prépare le travail et détecte les problèmes ; la
décision reste humaine.

**Ce que le projet fait aujourd'hui, en une phrase :** il répond à une question
de dirigeant à partir de données de démonstration, prépare un devis depuis une
fiche produit sans jamais inventer un montant, et bloque toute action sensible
derrière une approbation humaine.

> ⚠️ **Les données métier livrées sont des données de démonstration.** Elles ne
> sont pas les données de l'entreprise. Aucun raccordement à des données réelles
> n'est effectué par défaut.

---

## 2. Architecture générale

```
Dirigeant
   │  question en langage naturel
   ▼
Director / Orchestrator          planifie, délègue, consolide
   │
   ▼
Agents spécialisés (10)          chacun borné à sa mission
   │
   ▼
Tools (25)                       une capacité vérifiable, autorisée
   │
   ▼
Business Memory                  15 domaines métier, contrat unique
   │
   ▼
PostgreSQL / mémoire             deux implémentations, résultats identiques
```

| Couche | Rôle |
| --- | --- |
| **Director** | Reçoit la demande, construit un plan validé, délègue étape par étape, consolide les résultats et hiérarchise ce qui nécessite une décision. |
| **Agents** | Dix rôles métier. Un agent ne choisit pas ses outils : le planificateur les lui assigne, et ses permissions bornent ce qu'il peut atteindre. |
| **Tools** | Une capacité unitaire, avec ses agents autorisés, sa permission requise et ses domaines de sécurité. C'est le seul chemin vers la donnée. |
| **Business Memory** | Contrat unique de lecture sur quinze domaines. Un outil ne connaît pas le stockage sous-jacent. |
| **Stockage** | PostgreSQL via Prisma 7, ou une implémentation en mémoire. Les deux renvoient des enregistrements identiques. |

**Les 10 agents** : `director`, `commercial`, `finance`, `production`,
`purchasing`, `hr`, `after_sales`, `marketing`, `community_manager`, `legal`.
Le Community Manager rend compte au Marketing, pas au Directeur.

**25 outils** sont enregistrés par défaut. Un 26ᵉ, `notify_delay_alert`,
n'apparaît que si la passerelle n8n est activée — voir [§12](#12-n8n).

Le planificateur par défaut est **déterministe** : il sélectionne les agents en
analysant la formulation de la demande et leur assigne une liste d'outils fixe.
**Aucun modèle de langage n'est sollicité dans cette configuration.**

Détail complet des agents, de leurs outils, permissions et domaines de sécurité :
[`docs/AGENTS.md`](docs/AGENTS.md). Architecture technique :
[`docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md).

### Le rapport du Directeur

Dix rubriques, conformément au §31 du cahier des charges :

| Rubrique | Ce qu'elle porte |
| --- | --- |
| **CE QUI VA BIEN** | Commandes à l'heure, signaux positifs |
| **RETARDS / PROBLEMES** | Commandes en danger ou en retard, réclamations qualité |
| **A ENCAISSER** | Créances, montant et devise, ancienneté du retard |
| **A COMMANDER** | Manques de matière et besoins d'achat |
| **RISQUES / BLOCAGES** | Ce qui menace un engagement, sans arbitrage demandé |
| **DECISIONS NECESSAIRES** | Ce qui attend un arbitrage du dirigeant |
| **CE QUI NECESSITE UNE ACTION COMMERCIALE** | Devis sans réponse, relances |
| **CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION** | Campagnes et contenus |
| **CE QUI NECESSITE UNE INTERVENTION SAV** | Dossiers après-vente ouverts |
| **CE QUI PRESENTE UN RISQUE JURIDIQUE** | Contrats, clauses, échéances |

Un même signal remonté par deux outils n'est compté qu'une fois.

---

## 3. Prérequis

| Élément | Version | Obligatoire |
| --- | --- | --- |
| **Node.js** | **20 ou supérieur** | **oui** |
| npm | fourni avec Node.js | oui |
| Git | — | oui, pour cloner |
| Docker | — | non — seulement pour le PostgreSQL local ([§7](#7-mode-postgresql-persistant)) |
| PostgreSQL | 14 ou supérieur | non — le mode mémoire fonctionne sans |
| Compte OpenAI | — | non — désactivé par défaut ([§11](#11-openai)) |
| Compte n8n | — | non — désactivé par défaut ([§12](#12-n8n)) |

Vérifier Node.js :

```bash
node --version
```

Le projet est développé sous Windows et n'utilise aucune dépendance native. Là
où une commande diffère selon le système, les trois variantes sont données.

---

## 4. Installation

```powershell
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
cd AI-AGENTS
npm.cmd ci
```

`npm ci` est recommandé pour reproduire exactement le lockfile de `main`.
Aucune étape de compilation : le projet est en JavaScript ESM natif.

Le design du cockpit est écrit avec **Tailwind CSS** (`src/frontend/tailwind.css`
et les classes de `index.html`). La feuille compilée `src/frontend/styles.css` est
versionnée : rien à compiler pour utiliser le cockpit, et il marche hors ligne.
Après une modification du design, recompiler :

```powershell
npm.cmd run css:build
```

Un test vérifie que `styles.css` correspond bien à la source.

---

## 5. Configuration `.env`

Toute la configuration passe par des variables d'environnement.
`.env.example` est la référence versionnée ; **il ne contient aucune valeur
réelle**. `.env` est ignoré par Git et ne doit jamais être commité.

Copier le modèle — **choisissez la ligne de votre système** :

```bash
cp .env.example .env
```

```text
Windows PowerShell :  Copy-Item .env.example .env
Windows cmd.exe    :  copy .env.example .env
macOS / Linux      :  cp .env.example .env
```

**Aucune variable n'est obligatoire pour démarrer.** Toutes ont un défaut
utilisable. La référence complète, variable par variable, avec son défaut et le
moment où elle devient nécessaire, est dans
**[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)**.

Comment `.env` est lu — c'est une particularité du projet :

- le fichier est chargé par un mécanisme **interne** au dépôt
  (`src/load-dotenv.js`), il n'y a **aucune dépendance `dotenv`** ;
- il est lu par `npm start`, `db:seed`, `db:seed:business`, `auth:create-token`
  et `data:ingest` ;
- **une variable déjà exportée dans le shell gagne toujours** sur le fichier ;
- le fichier n'est lu **qu'au démarrage** : après une modification, redémarrez.

> **Prisma 7 ne lit pas `.env` non plus.** `npm run db:generate` et
> `npm run db:migrate` résolvent `DATABASE_URL` via `prisma.config.js`, depuis
> l'environnement du processus. Exportez-la dans le shell avant de les lancer.

---

## 6. Démarrage rapide — Demo

Le chemin le plus court : **aucune base de données, aucun compte externe**. Il exige seulement `AUTH_MODE="demo"` pour que le cockpit obtienne automatiquement un jeton.

Dans `.env`, une seule ligne à changer :

```text
AUTH_MODE="demo"
```

Puis :

```bash
npm start
```

L'API écoute sur **http://127.0.0.1:3000**. Vérification immédiate :

```bash
curl http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","service":"ai-agents","timestamp":"..."}`

### Ouvrir le cockpit

Ouvrez **http://127.0.0.1:3000/app/** dans un navigateur.

La racine **http://127.0.0.1:3000/** sert la même page.

### Comment fonctionne le jeton de démonstration

En mode `demo`, et **seulement** dans ce mode, une route publique
supplémentaire est enregistrée : `GET /api/auth/demo-session`. Elle crée un
utilisateur `demo-leader` de rôle `leader`, émet un vrai jeton porteur et le
renvoie.

Le cockpit s'en sert tout seul : au premier appel, il regarde
`sessionStorage`, et s'il n'y trouve rien il appelle
`/api/auth/demo-session`, garde le jeton en session et l'envoie ensuite dans
l'en-tête `Authorization: Bearer …` de chaque requête. **Vous n'avez rien à
saisir.**

Pour obtenir le même jeton en ligne de commande :

```bash
curl http://127.0.0.1:3000/api/auth/demo-session
```

> ⚠️ `AUTH_MODE="demo"` est **refusé** si `NODE_ENV=production` : l'application
> ne démarre pas. C'est délibéré — cette route distribue un jeton valide à qui
> le demande.
>
> ⚠️ En `AUTH_MODE="token"`, cette route n'existe pas et le cockpit affiche
> « Authentification requise: aucun jeton disponible ». Voir [§8](#8-authentification-token).

### Ce que fait le cockpit

| Section | Ce qu'elle permet |
| --- | --- |
| **Director IA** | Poser la question dirigeant et lire la synthèse, le plan et les agents sollicités |
| **Test Hiba — Préparation de devis** | Préparer un devis depuis une fiche produit, sans qu'aucun prix soit inventé |
| **Documents H-KIDS** | Aperçu puis génération d'une facture ou d'un bon de livraison ([§10](#10-génération-des-documents-h-kids)) |
| **Actions nécessitant votre validation** | Approuver ou refuser ce que les agents ont préparé |
| **Voix** | Emplacement réservé — **non implémenté** |
| **Historique** | Les requêtes passées |

### Les routes de l'API

Toutes exigent `Authorization: Bearer <jeton>`, sauf `/health` et
`/api/auth/demo-session`.

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/health` | État du service, sans authentification |
| `GET` | `/api/auth/demo-session` | Jeton de démonstration — **mode demo uniquement** |
| `POST` | `/api/director/requests` | Question dirigeant, corps `{ "message": "..." }` |
| `POST` | `/api/requests` | Création d'une requête brute |
| `GET` | `/api/requests/:id` | Relecture d'une requête |
| `GET` | `/api/approvals` | Approbations en attente |
| `GET` | `/api/approvals/:id` | Une approbation |
| `POST` | `/api/approvals/:id/approve` | Approuver |
| `POST` | `/api/approvals/:id/reject` | Refuser |
| `POST` | `/api/quotes/datasheet` | Préparer un devis depuis une fiche produit |
| `POST` | `/api/documents/preview` | Aperçu validé d'un document H-KIDS |
| `POST` | `/api/documents/generate` | Génération après confirmation |
| `GET` | `/api/documents/:id/download` | Téléchargement du PDF ou du DOCX |
| `POST` | `/api/production/delay-alerts` | Alerte de retard vers n8n — **si la passerelle est activée** |

---

## 7. Mode PostgreSQL persistant

**PostgreSQL n'est pas nécessaire pour démarrer.** Sans `DATABASE_URL`,
l'application utilise un dépôt en mémoire : tout fonctionne, et **les données
disparaissent à l'arrêt du processus**. C'est le mode par défaut, et le mode de
la démonstration.

La persistance réelle demande PostgreSQL.

### Démarrer la base

Un `docker-compose.yml` est fourni. Il expose PostgreSQL **sur le port 5433**,
pas 5432 : une instance déjà présente sur le port par défaut est courante, et
entrer en conflit avec elle serait pire qu'un port inhabituel.

```bash
docker compose up -d db
```

Sans Docker, une installation locale convient — procédure dans
[`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md).

### Configurer

Dans `.env` :

```text
DATABASE_URL="postgresql://ai_agents:<mot_de_passe>@localhost:5433/ai_agents?schema=public"
BUSINESS_MEMORY_PROVIDER="postgres"
```

Les identifiants du conteneur local sont écrits en clair dans
`docker-compose.yml`. Ce sont des identifiants de développement jetables : **ne
les réutilisez nulle part ailleurs.**

> ⚠️ **Une `DATABASE_URL` renseignée mais invalide arrête l'application** avec
> une erreur explicite. Elle ne retombe plus en silence sur le dépôt mémoire.
> Laissée vide, elle signifie « pas de base », ce qui reste parfaitement
> valide. Voir [§14](#14-dépannage).

### Préparer le schéma et les données

Dans cet ordre :

```bash
npm run db:generate
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run db:seed:business -- --apply
```

| Commande | Effet |
| --- | --- |
| `db:generate` | Génère le client Prisma |
| `db:migrate` | Applique les **6** migrations versionnées |
| `db:seed` | Sème les 10 agents et leurs permissions |
| `db:seed:business -- --apply` | Charge les données métier de démonstration |

`db:seed:business` est en **simulation par défaut** : sans `--apply`, il valide
et n'écrit rien. Les deux seeds sont **idempotents** — les relancer ne crée pas
de doublons.

Le schéma compte **26 modèles Prisma** répartis entre l'orchestration et la
mémoire métier. Détail :
[`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md).

### Importer les données réelles H-KIDS

Les données réelles arrivent par le classeur
[`docs/modele-donnees-hkids.xlsx`](docs/modele-donnees-hkids.xlsx) : Clients,
Devis, Commandes, Paiements, Achats, Fournisseurs. L'entreprise le remplit ;
le fichier rempli contient des données personnelles et **ne se verse jamais
dans le dépôt**.

```bash
npm run data:import-hkids -- --file=C:/chemin/donnees-hkids.xlsx
```

Sans `--write`, la commande vérifie tout et n'écrit rien. Chaque problème est
indiqué par onglet et numéro de ligne (client inconnu, date illisible, valeur
hors liste), et **un seul problème bloque tout l'import**. Une fois le fichier
propre :

```bash
npm run data:import-hkids -- --file=C:/chemin/donnees-hkids.xlsx --write
```

Les enregistrements sont écrits sous la source `future_real_data`, jamais sous
`demo` ; réimporter le même classeur les met à jour sans doublon. Les retards,
priorités et décisions sont calculés **au jour de l'import** : réimportez le
classeur dès qu'il change, et au moins une fois par jour. Une ligne supprimée
du classeur n'est pas supprimée de la base : changez plutôt son statut.

Pour que le Directeur lise ces données au lieu de la démonstration, dans `.env` :

```
BUSINESS_MEMORY_PROVIDER="postgres"
BUSINESS_DATA_PROVIDER="future_real_data"
BUSINESS_PROVIDER_ADAPTER="future_real_data"
BUSINESS_DATA_SOURCE_ID="future_real_data"
```

Les agents Commercial, Finance, Production et Achats lisent alors les données
importées. RH, SAV, Marketing, Community Manager et Juridique n'ont pas encore
d'onglet dans le classeur.

---

## 8. Authentification Token

`AUTH_MODE="token"` est le **défaut**. Chaque appel `/api/…` exige un jeton
porteur. Seul le condensat du jeton est stocké, jamais le secret.

Créer un jeton :

```bash
npm run auth:create-token -- --user-id=hiba --role=leader
```

Le secret est affiché **une seule fois**, à la création. Notez-le.

Options : `--user-id` (obligatoire), `--name`, `--role`, `--email`,
`--display-name`, `--company`. Rôles disponibles : `viewer`, `operator`,
`approver`, `leader`. Approuver une action demande au moins `approver`.

Cloisonnement (recette, scénario 7) :

- chaque compte appartient à une société (`--company`, sinon
  `HKIDS_COMPANY_ID`, `hkids` par défaut). Le serveur refuse tout compte d'une
  autre société, à la connexion comme à chaque appel, avec la même réponse
  qu'un mauvais jeton. Un compte créé avant ce réglage appartient à la
  société du serveur ;
- les salaires et les dépenses marquées « confidentielles » ne sont visibles
  en détail que du rôle `leader` (droit `view_confidential`). Pour les autres
  rôles, la ligne apparaît masquée : son numéro, son jour et son état, sans
  montant, libellé ni bénéficiaire. Son justificatif, son approbation, son
  rapprochement et son annulation leur sont refusés (403, tracé au journal
  d'audit), comme la saisie d'un salaire. Le fil de l'équipe, les réponses
  du Director et le résumé qui lui est donné les masquent de même. Les
  totaux de caisse les comptent toujours, pour que la caisse reste juste.
  Ces lignes sont regroupées sous « Dépenses confidentielles », sans détail
  par catégorie.

Utiliser le jeton :

```bash
curl -H "Authorization: Bearer <votre_jeton>" http://127.0.0.1:3000/api/approvals
```

> **Ce script lit `.env`.** Ce n'était pas le cas auparavant : une
> `DATABASE_URL` présente uniquement dans `.env` était invisible, le jeton
> était écrit dans un dépôt en mémoire, affiché, puis perdu à la fin du
> processus. C'est corrigé — avec une `DATABASE_URL` valide, le jeton est
> persisté en base.

> ⚠️ **Le cockpit ne sait pas encore saisir un jeton.** En mode `token`, il
> affiche « Authentification requise: aucun jeton disponible ». Pour une
> démonstration au navigateur, utilisez `AUTH_MODE="demo"` ; le mode `token`
> s'utilise aujourd'hui via l'API.

---

## 9. Tests et validation

Quatre contrôles, tous exécutables hors ligne :

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run scan:secrets
```

| Commande | Ce qu'elle fait |
| --- | --- |
| `npm test` | Suite complète, via le lanceur natif `node --test` |
| `npm run lint` | Validation syntaxique de chaque fichier JavaScript |
| `npm run build` | Validation de build — **aucune compilation n'est requise**, et la commande le dit |
| `npm run scan:secrets` | Recherche de secrets en dur, motifs et heuristiques |
| `npm run typecheck` | TypeScript n'est pas configuré ; la commande le dit et rend la main |

### Résultat mesuré

Dernière exécution vérifiée, **sans PostgreSQL** :

```text
tests     805
pass      771
fail        0
skipped    34
```

`lint`, `build`, `typecheck` et `scan:secrets` : PASS. Clone propre, démarrage serveur, `/health`, `/app/`, Director/Finance et preview H-KIDS avec gabarit DEV : PASS.

**Les 34 tests ignorés sont exactement les tests d'intégration PostgreSQL.**
Ils sont répartis sur 12 fichiers, tous conditionnés à `RUN_POSTGRES_INTEGRATION`
et à une `DATABASE_URL` valide. Aucun autre test n'est ignoré pour une autre
raison.

### Lever les 34 ignorés

Avec PostgreSQL démarré et migré, dans `.env` :

```text
RUN_POSTGRES_INTEGRATION="true"
DATABASE_URL="postgresql://ai_agents:<mot_de_passe>@localhost:5433/ai_agents?schema=public"
```

Ces deux variables doivent être **dans l'environnement du processus de test**.
Le lanceur `node --test` ne lit pas `.env` : exportez-les.

```bash
export RUN_POSTGRES_INTEGRATION=true && export DATABASE_URL="postgresql://..." && npm test
```

```text
Windows PowerShell :  $env:RUN_POSTGRES_INTEGRATION="true"; $env:DATABASE_URL="postgresql://..."; npm test
Windows cmd.exe    :  set RUN_POSTGRES_INTEGRATION=true && set DATABASE_URL=postgresql://... && npm test
```

Les 34 tests s'exécutent alors au lieu d'être ignorés. **Le nombre de tests
réussis dans cette configuration n'est pas mesuré dans ce document** : ne le
supposez pas, exécutez-le.

### Trois familles de tests méritent d'être signalées

- **Équivalence Memory ↔ PostgreSQL** — le même rapport doit sortir des deux
  implémentations, rubrique par rubrique.
- **Cohérence de la documentation** — la suite échoue si un agent, un outil, un
  domaine, un modèle ou une migration est ajouté sans être documenté dans
  `docs/`, ou si un `npm run …` cité dans `docs/` n'existe pas.
- **Non-dérive des permissions** — un instantané figé du modèle de moindre
  privilège, qui échoue à tout élargissement non délibéré.

---

## 10. Génération des documents H-KIDS

Le projet génère trois pièces : **facture**, **bon de livraison** et **bon de
commande**, chacune en **PDF et en Word**.

Toutes les pièces H-KIDS — **facture, bon de livraison et bon de commande** — sont
dessinées par le code, dans le design adopté avec les bons de commande et les
devis : logo et coordonnées de la société (adresse du registre, DOUAR HARAKAT N
2153 TASSELTANT SAADA MARRAKECH), titre et objet, tableau à en-tête vert, totaux
sur bandeau vert, conditions de règlement, puis selon la pièce un bloc « Bon pour
accord » (commande) ou « Réception de la livraison » (BL). **Aucun gabarit n'est
à fournir** : seuls le logo du dépôt et une police `.ttf` sont nécessaires.

Trois garanties structurent cette fonctionnalité :

1. **Rien n'est inventé.** Un champ manquant, une valeur ambiguë ou un total qui
   ne tombe pas juste arrête la génération et nomme le problème.
2. **Un aperçu avant tout.** La génération exige un jeton d'aperçu qui
   correspond exactement à ce qui a été relu.
3. **Un numéro de bon de commande n'est jamais attribué deux fois** : la série
   reprend après les bons émis à la main, et un numéro déjà pris est refusé.

Depuis le cockpit : section **Documents H-KIDS**, remplir, **Aperçu**, relire,
puis **Valider et générer**. Les deux fichiers apparaissent en téléchargement.

Les fichiers générés sont écrits dans **`assets/documents/generated/`**, un
répertoire **ignoré par Git** : ces documents portent des données client.

> ⚠️ **La génération PDF exige aussi une police `.ttf` présente sur la machine.**
> Sans configuration, le projet en cherche une aux emplacements habituels de
> Windows, macOS et Linux. S'il n'en trouve aucune, il s'arrête en nommant la
> variable à renseigner — il n'utilise jamais une police de remplacement
> silencieuse. Voir [§14](#14-dépannage).

Variables et messages d'erreur :
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md), section « Documents H-KIDS ».

---

## 11. OpenAI

Le **Director IA conversationnel** et l'équipe d'agents utilisent OpenAI dès que
`OPENAI_API_KEY` est renseignée. Sans clé, le cockpit garde le Director à
mots-clés et le projet fonctionne entièrement hors ligne.

```text
OPENAI_API_KEY="<la clé de l'entreprise, jamais commitée>"
OPENAI_MODEL="gpt-5"
OPENAI_REASONING_EFFORT="low"
```

- `OPENAI_MODEL` : `gpt-5` par défaut.
- `OPENAI_REASONING_EFFORT` : `minimal`, `low` (défaut), `medium` ou `high`, pour
  les modèles qui raisonnent (GPT-5, série o). `low` ramène une réponse à deux
  agents d'environ 80 s à environ 30 s.
- Temps de réponse constatés : quelques secondes pour un document, 20 à 75 s
  quand plusieurs agents travaillent.

Ce que fait le modèle et ce qu'il ne fait pas :

- il **choisit et remplit des outils** ; l'avancement d'un objectif (réalisé,
  écart, rythme, devis ouverts) est **calculé par le code**
  (`src/agent/sales-objective.js`), jamais estimé par le modèle ; chaque montant est recalculé par le code
  et chaque document passe par la même validation et le même aperçu qu'un
  document saisi à la main ;
- les agents lisent leurs données par `ToolExecutionService` : permissions,
  domaines de sécurité et journal d'audit s'appliquent comme au planificateur ;
- les incohérences entre métiers sont **calculées par le code**
  (`src/agent/consistency.js`), jamais rédigées par le modèle ;
- la chaîne d'une vente (devis → bon de commande → factures) est lue sur les
  documents générés (`src/documents/document-ledger.js`) : une facture qui
  dépasserait le montant de la vente est refusée ;
- le carnet d'atelier (`src/agent/workshop-book.js`, fichier `data/atelier.json`)
  suit chaque bon de commande validé à travers les 8 étapes de fabrication ;
  l'avancement est calculé sur les étapes terminées, jamais estimé ;
- le bureau d'études de chaque commande (panneau « Bureau d'études » de la vue
  Atelier, outil `equipe_commande` du Director et de la Production) : le chef
  de charge qui en répond et son numéro WhatsApp (il y reçoit, une fois par
  anomalie, chaque étape de sa commande qui se bloque ou prend du retard, et
  sa réponse arrive à la Production comme compte rendu ; un message refusé
  par Meta est noté au fil d'équipe), l'architecte du client et la personne de l'équipe
  en lien avec lui, le dessinateur et son numéro WhatsApp. Après la fiche
  technique (étude technique terminée), le dessinateur dépose le G-code ou le
  DXF (`data/atelier-cnc/`, 8 Mo au plus, contenu vérifié) depuis le cockpit,
  ou l'envoie au numéro WhatsApp de l'entreprise avec « BC 171 » en légende
  (sans légende : sa seule commande en cours). Il n'atteint que les commandes
  dont il est le dessinateur ; la direction est prévenue sur WhatsApp. La
  direction le
  valide ou le refuse avec un motif (droit de décider, jamais un agent), et la
  découpe CNC ne peut pas commencer avant. Rien de tout cela n'est montré au
  client ;
- Production coordonne deux agents IA distincts : `dessinateur_2d3d` prépare
  la fiche technique et ses vues d'encombrement 2D/3D ;
  `dessinateur_methodes` transforme sa version validée en dossier complet
  (liste des pièces, quantités, matériaux, débit, calepinage et fiches par
  opération, avec machine, ordre et instructions). Seules les opérations
  nécessaires figurent dans ces fiches : CNC, scie à panneaux, rabotage ou
  autres postes selon le meuble. Toute information manquante est demandée
  avant génération. Chaque livrable est enregistré dans
  `data/commandes/BC<référence>/`, versionné et rattaché à la fiche globale.
  Pour les pièces CNC, le moteur `dessinateur/` produit plans détaillés,
  calepinage et DXF (R2010, mm, 1:1). Production transmet les DXF à la
  direction : **aucun G-code avant validation de tous les DXF courants**.
  Le G-code exige les paramètres réels, le post-processeur qualifié sur la
  machine par programme pilote, la simulation intégrée sans erreur, puis
  la validation du responsable atelier. Une correction conserve les
  archives et rend les anciens programmes obsolètes pour utilisation.
  Les formats, les routes et un exemple de fiche sont décrits dans
  [`dessinateur/README.md`](dessinateur/README.md) ;
- l'export comptable (`src/agent/accounting-export.js`, route
  `GET /api/accounting/journal.xlsx?from=AAAA-MM-JJ&to=AAAA-MM-JJ`, outil
  `export_comptable` du Director) donne au comptable le journal des écritures
  en Excel, une ligne par compte, débit égal au crédit : les factures et les
  avoirs (client 3421, ventes 7121, TVA facturée 4455), puis les mouvements
  de caisse (caisse 5161 ou banque 5141, charges 61xx). Les paiements viennent
  du journal de caisse, jamais des reçus, pour n'être comptés qu'une fois ;
  un salaire reste masqué à qui n'a pas le droit de le voir. Les comptes sont
  ceux du CGNC usuels pour un fabricant, remplaçables (`HKIDS_ACCOUNTS`) : c'est
  une **proposition**, le comptable décide de ce qu'il passe ;
- le coût de l'IA est suivi (`src/agent/ai-usage.js`, route
  `GET /api/ai-usage`, panneau « Coût de l'IA ce mois » de la vue Équipe,
  outil `couts_ia` du Director) : chaque appel au modèle est compté pour
  l'agent qui l'a fait (Director, agents, vocaux WhatsApp), avec les jetons
  rapportés par OpenAI ; le coût est une **estimation** d'après le tarif
  public du modèle (`HKIDS_AI_PRICES` le corrige), la facture OpenAI fait
  foi. Un budget mensuel (`HKIDS_AI_BUDGET_USD`) alerte à 80 % puis à 100 %
  dans le fil de l'équipe et sur le WhatsApp de la direction ;
  `HKIDS_AI_BUDGET_STOP="on"` arrête aussi le Director une fois le budget
  atteint ;
- le Director joint un PDF à sa réponse (outil `joindre_pdf`,
  `src/documents/note-pdf.js`) : une fiche, un mémo, une procédure ou une
  synthèse, en A4 avec l'en-tête H KIDS, à télécharger sous la réponse et
  rangé dans le dossier Exports ; les devis, bons et factures gardent leurs
  modèles numérotés ;
- le bilan commercial (outil `bilan_commercial` du Director et du Commercial,
  route `GET /api/commercial`) est calculé sur les documents générés par le
  cockpit : devis émis, ventes signées (devis → BC, datées par le BC), taux de
  transformation, devis perdus et leur motif, devis ouverts, à relancer,
  livraisons en retard ; chaque chiffre cite ses numéros. Les relances faites
  et les refus sont enregistrés (`enregistrer_relance`, fichier
  `data/relances.json`) ; un devis ouvert sans nouvelles depuis
  `HKIDS_FOLLOW_UP_DAYS` jours (5 par défaut) est rappelé par WhatsApp à la
  personne reliée au Commercial, et à la direction au double de ce délai
  (ou tout de suite si personne n'est relié), une seule fois, entre 8 h et
  20 h. Sa réponse « relance du devis 170 faite… » est enregistrée comme
  relance. Une livraison en retard est signalée au Commercial pour prévenir
  le client ;
- chaque anomalie est une tâche (même numéro) avec une gravité (un blocage
  est grave), un métier, une personne, une échéance et un statut : ouverte,
  prise en charge, résolue à confirmer, clôturée. Une anomalie grave est
  envoyée à la direction sur WhatsApp dès qu'elle est trouvée. Chaque matin
  ouvré, la direction reçoit le résumé (ouvertes, graves, sans responsable,
  en retard, à clôturer). La direction assigne la tâche dans la vue
  Amélioration ou au Director (« assigne l'anomalie 4 à la production, Samir,
  pour le 25/11 »), et la personne en est prévenue sur WhatsApp. Elle répond
  « tâche 4 prise en charge » puis « tâche 4 résolue : … » ; une tâche passée
  son échéance lui est rappelée une fois par jour. Seule la direction clôture
  une tâche, par le bouton du cockpit (droit de décider) ou en répondant
  « clôture tâche 4 » ; elle peut aussi la rouvrir avec un motif ;
- le client suit sa commande sur un lien à lui (`/suivi/<jeton>`, page
  `src/frontend/suivi.html`) : avancement réel, étapes terminées, livraison
  prévue, échéancier, photos publiées et documents de sa vente, jamais les
  notes, les responsables ni la raison d'un blocage. Le lien se crée et se
  coupe depuis le cockpit ou par le Director ; un lien coupé ne se rallume
  jamais (`PUBLIC_BASE_URL` donne l'adresse complète des liens) ;
- rien n'est envoyé, payé ni commandé par un agent : messages WhatsApp, documents
  et plans attendent la validation de la direction.

Le code : `src/agent/` (Director, équipe, catalogue, WhatsApp, plans,
cohérence, atelier) et les routes `/api/agent/*`, `/api/plans*`, `/api/workshop*`
et, sans connexion, `/api/public/suivi/*`.

L'ancien planificateur LLM (`PLANNER_PROVIDER="llm_openai"`) reste disponible
pour l'endpoint `/api/director/requests` ; il est indépendant de l'agent
conversationnel. Détail : [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md).

---

## 12. n8n

**Optionnel et désactivé par défaut.** `WORKFLOW_ENABLED="false"` et
`WORKFLOW_PROVIDER="mock"` dans `.env.example`. Sans activation :

- aucun client n8n n'est construit ;
- l'outil `notify_delay_alert` **n'est pas enregistré** — le registre compte 25
  outils au lieu de 26 ;
- `POST /api/production/delay-alerts` répond **409 `WORKFLOW_NOT_ENABLED`** ;
- **aucun appel sortant n'est possible.**

Pour activer la passerelle, les sept variables sont décrites dans
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md). Le principe :

```text
WORKFLOW_PROVIDER="n8n"
WORKFLOW_ENABLED="true"
WORKFLOW_BASE_URL="https://<votre-instance>/webhook"
N8N_WEBHOOK_PATH="<chemin du webhook>"
N8N_API_KEY_HEADER="X-AI-Agents-Token"
N8N_API_KEY="<votre jeton, jamais commite>"
```

Ce que le code garantit, et qui compte plus que la configuration :

- **une alerte ne part jamais sans approbation humaine.** L'appel HTTP a lieu à
  l'approbation, pas à la création de l'alerte ;
- une approbation ne peut pas être rejouée pour envoyer deux fois ;
- le jeton n'est jamais une propriété d'un objet : il vit dans une fermeture, et
  la configuration n'expose que `hasApiKey` ;
- la réponse de n8n **doit être du JSON valide**, sinon l'exécution est
  enregistrée en échec.

> ⚠️ **Cette passerelle n'a jamais été validée par un appel réel** au moment de
> cette livraison. Elle est entièrement testée hors ligne, avec un client
> injecté. Voir [§15](#15-état-du-mvp).

---

## 13. Structure du projet

```
src/
  api/              Fastify, routes, authentification, limitation de debit
  agents/           Les 10 agents, permissions, seed
  director/         Planification et consolidation du rapport
  tools/            Les 25 outils et leurs adaptateurs
  business-memory/  Contrat de lecture, 15 domaines, memoire et Prisma
  documents/        Generation H-KIDS : validation, PDF, DOCX, verrous
  security/         Jetons, roles, permissions, domaines, approbations
  integrations/     Frontieres externes : n8n, fournisseur IA
  workflows/        Contrat des evenements de workflow
  persistence/      Depots memoire et Prisma
  observability/    Audit
  frontend/         Le cockpit : index.html, app.js, tailwind.css (source) → styles.css (compilé)
  demo/             Donnees de demonstration
  config.js         Lecture de la configuration
  load-dotenv.js    Chargement de .env, sans dependance
  server.js         Point d'entree de npm start

scripts/            Seeds, jetons, lint, build, scan de secrets, ingestion
prisma/             schema.prisma et 6 migrations
test/               La suite complete
docs/               Documentation
assets/documents/   Logo H-KIDS (les pièces sont dessinées par le code).
  generated/        Documents produits — ignore par Git
```

### Documentation

| Document | Contenu |
| --- | --- |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | **Toutes les variables d'environnement**, par catégorie |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Les 10 agents, outils, permissions, domaines de sécurité |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Les 26 modèles, les 15 domaines, les migrations |
| [`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md) | Installation de la base, Docker ou local |
| [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) | Sauvegarde, restauration, reprise du projet |
| [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md) | Choix du planificateur |
| [`docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md) | Architecture technique détaillée |
| [`docs/AGENT-MVP-BOUNDARIES.md`](docs/AGENT-MVP-BOUNDARIES.md) | Frontières du MVP |

Quatre documents décrivent l'**instantané V1** figé au commit `c2c1d89` et
portent leurs chiffres d'alors : [`DELIVERY_V1_MVP.md`](docs/DELIVERY_V1_MVP.md),
[`V1_INSTALLATION_GUIDE.md`](docs/V1_INSTALLATION_GUIDE.md),
[`V1_DEMO_GUIDE.md`](docs/V1_DEMO_GUIDE.md),
[`V1_TEST_REPORT.md`](docs/V1_TEST_REPORT.md). **Ce README fait foi pour l'état
courant.**

---

## 14. Dépannage

### Le port 3000 est déjà utilisé

Le port et l'hôte se règlent par `PORT` et `HOST` dans `.env` — défauts `3000`
et `127.0.0.1`. Les deux sont lus **au démarrage seulement**.

```text
PORT="3100"
```

Identifier ce qui occupe le port :

```text
Windows PowerShell :  Get-NetTCPConnection -LocalPort 3000
Windows cmd.exe    :  netstat -ano | findstr :3000
macOS / Linux      :  lsof -i :3000
```

> Ne laissez pas `PORT` vide : la valeur est convertie par `parseInt`, et une
> chaîne vide donne un port indéterminé. Renseignez-la ou retirez la ligne.

### `.env` semble ignoré

Trois causes, dans l'ordre de fréquence :

1. **Le serveur n'a pas été redémarré.** Le fichier n'est lu qu'au démarrage.
2. **La variable est déjà exportée dans le shell.** L'environnement gagne
   toujours sur le fichier — c'est délibéré. Vérifiez avec
   `echo $env:MA_VARIABLE` (PowerShell) ou `echo $MA_VARIABLE` (bash).
3. **Le fichier n'est pas au bon endroit.** Il est cherché à `.env` **relatif au
   répertoire courant**, pas au répertoire du script. Lancez les commandes
   depuis la racine du dépôt.

Rappel : `npm run db:generate` et `npm run db:migrate` passent par Prisma, qui
ne lit pas `.env`. Exportez `DATABASE_URL` avant.

### `DATABASE_URL` invalide

```text
RepositoryConfigurationError: DATABASE_URL is set but is not a valid PostgreSQL
connection string. Fix it, or remove it to run on the in-memory repository.
  code: 'DATABASE_URL_INVALID'
```

C'est **volontaire**. Une URL renseignée mais qui n'est ni `postgresql://` ni
`postgres://` arrête l'application au lieu de retomber en silence sur le dépôt
mémoire — un comportement qui donnait une application démarrée, répondante, qui
ne persistait rien et ne le disait pas.

Deux issues : corriger l'URL, ou **vider complètement** `DATABASE_URL` pour
choisir explicitement le mode mémoire. Une valeur vide ou faite d'espaces est
acceptée comme « pas de base ».

### Police PDF absente

```text
No regular font was found on this machine. Set HKIDS_DOCUMENT_FONT_PATH to the
absolute path of a .ttf file.
```

Renseignez les deux variables avec des **chemins absolus** vers des fichiers
`.ttf` :

```text
HKIDS_DOCUMENT_FONT_PATH="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
HKIDS_DOCUMENT_BOLD_FONT_PATH="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
```

Message voisin, cause différente :

```text
HKIDS_DOCUMENT_FONT_PATH points to a font file that cannot be read: <chemin>
```

Là, la variable est renseignée mais le fichier n'existe pas ou n'est pas
lisible. Le projet **ne remplace jamais** une police configurée par une autre.

### PostgreSQL : vérifier que le conteneur tourne

```bash
docker compose ps
```

La colonne d'état doit indiquer `running` et le service `healthy` — le conteneur
ne se déclare prêt qu'une fois qu'il accepte des requêtes.

```bash
docker compose logs db
```

Tester la connexion depuis le conteneur :

```bash
docker compose exec db pg_isready -U ai_agents -d ai_agents
```

Si le port 5433 est déjà pris, changez `POSTGRES_HOST_PORT` dans `.env` **et**
le port dans `DATABASE_URL`.

### n8n

**n8n n'est nécessaire à aucun démarrage standard.** S'il est désactivé, rien
ne le réclame et aucune fonctionnalité de ce README n'en dépend, à la seule
exception de `POST /api/production/delay-alerts`, qui répond alors
`409 WORKFLOW_NOT_ENABLED` — et c'est la réponse correcte.

Si vous l'activez et que l'appel échoue, l'erreur porte un `boundaryCode` :
`N8N_UNEXPECTED_STATUS` (le webhook n'a pas répondu 2xx — workflow inactif ou
en-tête d'authentification refusé), `N8N_INVALID_RESPONSE` (la réponse n'était
pas du JSON), `N8N_REQUEST_TIMEOUT`, `N8N_REQUEST_FAILED`.

---

## 15. État du MVP

| Domaine | État |
| --- | --- |
| Director IA conversationnel | ✅ Rôle de directeur : objectif chiffré mesuré sur les données, stratégie, part de chaque responsable, synthèse et décisions ; délègue toute l'exécution |
| Équipe d'agents IA | ✅ 9 agents (dont les 5 + Community Manager du schéma validé), outils et droits propres, testés en réel |
| Plan d'action et suivi | ✅ Plan visible, étapes par agent, échéances, statuts, journal, repris d'un jour à l'autre (vue **Plans**) |
| Cohérence entre métiers | ✅ Contrôles calculés : production sans acompte, achat avant paiement, livré non payé… |
| Documents H-KIDS | ✅ Devis, bon de commande, facture, BL dans le design H-KIDS, PDF + Word, préparés par le Commercial ou la Finance |
| Catalogue | ✅ Lu par le Commercial — **à remplir par l'entreprise** (`data/catalogue-hkids.xlsx`) |
| Messages WhatsApp | 🟡 Rédigés par les agents, envoyés par Hiba depuis WhatsApp (lien `wa.me`) ; pas d'envoi automatique |
| Orchestration, permissions, audit | ✅ Moindre privilège, approbation humaine, journal |
| PostgreSQL | ✅ Migrations versionnées, équivalence mémoire / base vérifiée |
| Interface | ✅ Cockpit : Briefing (conversation), Plans, Validations, Documents, Devis, Dossier, Équipe |
| Données réelles de l'entreprise | 🔴 **En attente** : import prêt (`npm run data:import-hkids`), fichiers à remplir par Hiba |
| Accès en ligne | 🔴 **Non fait** : fonctionne en local ; hébergement et comptes nominatifs à prévoir |
| Voix | 🔴 **Non intégré** |

### Sécurité et validation humaine

**Quatre contrôles indépendants** avant qu'un outil s'exécute :

1. l'outil nomme les agents autorisés à l'appeler ;
2. l'agent détient la permission requise (`read_analyze`, `prepare_action`,
   `execute_action`) ;
3. l'agent détient **tous** les domaines de sécurité que l'outil lit ;
4. **tout outil dont la permission n'est pas `read_analyze` s'arrête et attend
   une décision humaine** — sans exception.

Un agent détient exactement les domaines de sécurité que ses propres outils
exigent, ni plus ni moins. Ce modèle est figé par un test.

### Limites assumées

- Tant que le classeur d'Hiba n'est pas importé, les agents travaillent sur des
  **données de démonstration** (« Demo Client Atlas ») et le signalent.
- Une confirmation donnée au Director (« l'acompte est arrivé ») met à jour le
  **plan**, pas encore les **données métier** : elles se mettent à jour par un
  nouvel import du classeur.
- Les conversations avec le Director sont gardées en mémoire du serveur : un
  redémarrage les efface (les plans, eux, sont conservés).
- Le mode `AUTH_MODE="demo"` donne l'accès à quiconque atteint le serveur : il
  convient à un poste local, pas à un accès en ligne.
- Il n'existe ni sauvegarde planifiée ni restauration à un instant donné.

### Prochaines étapes

1. Importer les données réelles et le catalogue d'Hiba.
2. Héberger le système (serveur au nom de l'entreprise) avec un compte par
   personne (Hiba, Hicham, Omar).
3. Faire mettre à jour les données métier par les confirmations données au
   Director, et conserver les conversations.
4. Envoi WhatsApp automatique (WhatsApp Business Platform de Meta, modèles
   approuvés) si le volume le justifie.
5. Sauvegardes planifiées avant toute mise en production.

---

## 📄 Licence

**Aucune licence n'est définie à ce jour.** `package.json` n'en déclare pas et
le dépôt n'en contient aucune. En l'absence de licence explicite, tous les
droits sont réservés par défaut.

La propriété de l'infrastructure — comptes, dépôt, base de données, hébergement
— revient à l'entreprise, conformément au §20 du cahier des charges.
