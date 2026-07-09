# RoleMaster

Gestionnaire de jeux de rôle multijoueur en temps réel, partie de la suite **VGAMES**.

> Cette application est accessible depuis le portail [VGAMES](http://localhost:3000). L'utilisateur connecté sur VGAMES n'a pas besoin de se reconnecter.

## Fonctionnalités

- Gestion de sessions de jeu de rôle en temps réel
- Interface multijoueur via Socket.io
- Tableau de bord de gestion des parties

## Intégration VGAMES

RoleMaster fait partie de la suite VGAMES. Il est accessible depuis le launcher VGAMES (`/games`) et tourne sur son propre port (`3003`). L'intégration SSO (authentification partagée avec VGAMES) est prévue dans une prochaine version.

## Tech Stack

| Couche | Technologie |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Temps réel | Socket.io |

## Installation et démarrage

### Prérequis

- Node.js 18+
- **VGAMES** démarré sur le port `3000`

### 1. Configurer l'environnement

Le fichier `.env` est présent à la racine :

```env
PORT=3003
```

### 2. Installer les dépendances

```bash
npm install
```

### 3. Démarrer l'application

```bash
npm start
# → http://localhost:3003
```

## Mise en production

RoleMaster est déployé sur `https://rolemaster.vgames.fr` (serveur Hetzner
Cloud, base de données MongoDB Atlas). Récapitulatif de la mise en place :

### HTTPS

RoleMaster suppose qu'un reverse proxy termine le HTTPS devant lui (le cookie
de session est configuré en `secure:'auto'`, donc marqué sécurisé uniquement
si la requête arrive effectivement en HTTPS) — RoleMaster lui-même continue
d'écouter en HTTP simple sur le port `3003`, jamais exposé directement sur
Internet. En production, c'est **Caddy** qui gère ça (HTTPS automatique via
Let's Encrypt). Deux configurations de référence sont fournies dans
[`deploy/`](deploy/) : [`Caddyfile.example`](deploy/Caddyfile.example) (celle
utilisée) et [`nginx.conf.example`](deploy/nginx.conf.example) en alternative.

### Page légale

[`public/legal.html`](public/legal.html) (mentions légales + politique de
confidentialité, liée depuis la connexion, l'inscription et le tableau de
bord) est à jour : hébergement chez Hetzner Online GmbH (application) et
MongoDB Atlas région Paris/eu-west-3 (base de données) — toutes deux dans
l'Union européenne.

### Ce qui est déjà en place

- En-têtes de sécurité (Helmet), limitation de débit (100 req/min), mots de
  passe hachés (bcrypt), sessions stockées côté serveur (MongoDB).
- Aucun cookie non-essentiel, aucun outil d'analytics/publicité tiers — pas de
  bandeau de consentement RGPD nécessaire (seul `connect.sid`, cookie de
  session strictement nécessaire, est déposé).

## Auteur

Miro_ — VGAMES 2024
