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

## Auteur

Miro_ — VGAMES 2024
