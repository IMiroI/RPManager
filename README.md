# RoleMaster

Gestionnaire de jeux de rôle multijoueur en temps réel, partie de la suite **VGAMES**.

> Cette application est accessible depuis le portail [VGAMES](http://localhost:3000). L'utilisateur connecté sur VGAMES n'a pas besoin de se reconnecter.

RoleMaster propose deux façons de jouer, selon le format de partie voulu par le maître du jeu (MJ).

## 🎲 OneShot — une partie, une soirée

Le format d'origine, pensé pour une partie ponctuelle sans engagement :

- Le MJ prépare les personnages (statistiques, compétences) dans un éditeur dédié.
- Chaque lancement de partie génère un **code de session** à usage unique — les joueurs le saisissent pour rejoindre, sans avoir besoin de créer de compte.
- Le MJ distribue un personnage à chaque joueur connecté, puis lance la partie.
- Jets de dés et de compétences en temps réel, suivis par tout le monde.

## 📖 Aventure — une campagne qui dure

Le format pour les campagnes qui se jouent sur plusieurs séances, avec une vraie persistance des personnages et de l'histoire entre deux soirées.

### Comptes et organisation

- MJ et joueurs ont chacun un compte — les personnages et leur progression survivent à la fermeture du navigateur, à une semaine d'écart entre deux séances, ou à un redémarrage du serveur.
- Un **lien d'invitation permanent** (pas de code à retaper chaque semaine) donne accès à l'aventure.
- Un joueur peut créer **plusieurs personnages** sur une même aventure et les jouer simultanément en séance.
- Un onglet **« Gestion de mes personnages »** sur le tableau de bord regroupe tous ses personnages, toutes aventures confondues, sans avoir à retrouver chaque lien d'invitation.
- Il est possible de rejoindre une séance en direct **avant même d'avoir créé de personnage** — en observateur, le temps de s'en créer un ou d'en recevoir un du MJ.
- La création de personnage se fait par répartition de points selon un budget défini par le MJ pour son système de jeu.

### Préparation, côté MJ

- L'histoire se découpe en **chapitres** (notes, cartes et musiques qui leur sont propres, PNJ associés).
- Fiches de **PNJ** complètes : statistiques, compétences visibles *et* compétences cachées (réservées au MJ), rôle, disposition, couleur de token.
- **Médiathèque** : upload de cartes, de musiques et de sprites de décor (objets posés sur la carte, sans contour, réutilisables plusieurs fois).
- Les statistiques du système de jeu (noms, budget de points) sont définies librement par le MJ pour son aventure.

### La carte, en direct

- Grille tactique redimensionnable ; les tokens s'alignent automatiquement au centre des cases.
- Déplacement d'un token au clavier (flèches), rotation (Ctrl + flèches), retrait de la carte (Suppr).
- Zoom et déplacement de la vue indépendants pour chaque participant, sans affecter les autres.
- Couleur de contour personnalisable pour chaque personnage et chaque PNJ.
- **Brouillard de guerre** : le MJ peint les zones à révéler ou masquer à la souris, les joueurs découvrent aussi automatiquement les alentours en approchant leur personnage — grille de précision indépendante de la grille tactique, toujours en cases carrées.
- Le MJ peut **préparer une scène en la gardant masquée** aux joueurs (placer tokens et décor, peindre le brouillard) avant de la révéler d'un clic.
- **Ping** (clic droit sur la carte) pour signaler un point aux autres, dans la couleur du personnage qui pointe.
- Marqueur **KO / mort** (croix rouge) posable sur un token par le MJ.
- Un **PNJ peut être attribué à un joueur** en cours de route et devenir un personnage jouable par lui (stats, compétences et apparence repris tels quels).

### Combat et suivi

- **Suivi d'initiative** : ajout des participants (jet automatique), tri par score, tour par tour avec compteur de round, jeton actif mis en évidence sur la carte.
- Jets de **compétence** (1d100 + dé propre à la compétence), publics ou cachés des joueurs selon le PNJ ou la compétence concernée.
- Jets de **statistique** (1d100 simple, avec la valeur de référence), visibles uniquement du MJ et du joueur concerné — pour suivre des jets de stats précis sans avoir à rouvrir une fiche à chaque fois.
- Statistiques, inventaire et compétences modifiables en direct par le MJ, aussi bien pour les personnages que pour les PNJ.

### Communication

- **Journal de groupe** partagé : messages, jets de dé et de compétence, chacun avec l'avatar de son auteur.
- **Messages privés** (`/mp`) entre un joueur et le MJ.
- Musique diffusée par le MJ, synchronisée (de façon approximative) chez tous les participants connectés.

## Tech Stack

| Couche | Technologie |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Temps réel | Socket.io |
| Base de données | MongoDB / Mongoose |

## Intégration VGAMES

RoleMaster fait partie de la suite VGAMES. Il est accessible depuis le launcher VGAMES (`/games`) et tourne sur son propre port (`3003`). L'intégration SSO (authentification partagée avec VGAMES) est prévue dans une prochaine version.

## Auteur

Miro_ — VGAMES 2024

---

Installation locale et détails de mise en production : voir [`DEPLOYMENT.md`](DEPLOYMENT.md).
