# Discord Dev Bot

Bot Discord qui transforme une commande `!dev` en modification de code → build → commit → push automatique.

```
!dev ajoute une section pricing sur la landing page
```

**Pipeline complet :**
`Discord` → `Claude (Opus)` → `modification fichiers` → `npm run build` → `git push origin main`

---

## Prérequis

| Ce qu'il te faut | Où le récupérer |
|---|---|
| Token Discord bot | [discord.com/developers](https://discord.com/developers/applications) → Bot → Token |
| Clé API Anthropic | [console.anthropic.com](https://console.anthropic.com) |
| Token GitHub | GitHub → Settings → Developer settings → Personal access tokens (scope : `repo`) |
| Ton ID Discord | Discord → Paramètres → Avancé → Mode développeur → clic droit sur ton nom |

---

## Déploiement sur Railway

### 1. Créer le projet Railway

1. Va sur [railway.app](https://railway.app) → connecte-toi avec GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Sélectionne le repo qui contient ce dossier `discord-bot/`

> Si le bot est dans un sous-dossier, configure le **Root Directory** dans Railway :
> Project → Settings → **Root Directory** → `discord-bot`

---

### 2. Variables d'environnement

Dans Railway : onglet **Variables** → ajoute les 6 variables :

```
DISCORD_TOKEN=ton_token_discord
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
GITHUB_REPO=username/nom-du-repo
AUTHORIZED_USER_IDS=123456789012345678
WORKDIR=/app/workspace
```

> Pour plusieurs IDs autorisés, sépare-les par des virgules : `123,456,789`

---

### 3. Déploiement automatique

Railway fait automatiquement :
```
npm install
npm start        # → node index.js
```

Dès que tu cliques **Deploy** (ou que tu fais `git push`), le bot démarre.

---

### 4. Vérifier que ça tourne

Onglet **Deployments** → logs → tu dois voir :

```
[BOT] Connecté en tant que TonBot#1234
[BOT] IDs autorisés : 123456789012345678
[BOT] Repo cible    : username/nom-du-repo
[BOT] WORKDIR       : /app/workspace
```

---

### 5. Inviter le bot sur ton serveur

Dans le Discord Developer Portal :
1. **OAuth2** → **URL Generator**
2. Coche : `bot`
3. Permissions bot : `Send Messages`, `Read Message History`, `Embed Links`
4. Copie l'URL → ouvre-la → sélectionne ton serveur

---

### 6. Utilisation

```
!dev ajoute une section pricing sur la landing page
!dev change la couleur du bouton CTA en orange
!dev ajoute un composant FAQ avec 5 questions
!dev corrige le bug sur la page /onboarding
```

Le bot répond avec un embed mis à jour en temps réel :

```
📥 Repo       → synchronisation
🔍 Analyse    → lecture des fichiers
🧠 Claude     → génération des modifications
✏️ Modifs     → écriture des fichiers
🔨 Build      → npm run build
🚀 Push       → git commit + push
✅ Déployé !  → succès avec liste des fichiers modifiés
```

Si le build échoue, les modifications sont **annulées** et l'erreur est affichée dans Discord. Rien n'est pushé.

---

## Variables d'environnement — référence complète

| Variable | Obligatoire | Description |
|---|---|---|
| `DISCORD_TOKEN` | oui | Token du bot Discord |
| `ANTHROPIC_API_KEY` | oui | Clé API Anthropic (Claude) |
| `GITHUB_TOKEN` | oui | Personal Access Token GitHub (scope `repo`) |
| `GITHUB_REPO` | oui | Format `username/repo-name` |
| `AUTHORIZED_USER_IDS` | oui | IDs Discord autorisés, séparés par des virgules |
| `WORKDIR` | non | Dossier de travail (défaut : `./workspace`) |

---

## Erreurs classiques

| Erreur | Cause | Fix |
|---|---|---|
| Bot offline | `DISCORD_TOKEN` invalide | Régénère le token dans le Developer Portal |
| `GITHUB_TOKEN manquant` | Variable non définie | Vérifie les variables Railway |
| Build échoué | Erreur TypeScript / dépendance manquante | L'erreur est affichée dans Discord, rien n'est pushé |
| `Non autorisé` | Ton ID n'est pas dans `AUTHORIZED_USER_IDS` | Active le Mode développeur Discord et récupère ton ID |
| Claude retourne du JSON invalide | Demande trop vague | Sois plus précis dans ta demande `!dev` |

---

## Architecture

```
discord-bot/
├── index.js          ← bot complet (pipeline Discord → Claude → Git)
├── package.json
├── .env.example      ← copie → .env en local
└── README.md
```

### Flux interne

```
message !dev
  │
  ├─ vérification ID autorisé
  ├─ clone / git pull origin main
  ├─ lecture arborescence + fichiers src/
  ├─ appel Claude Opus avec contexte complet
  ├─ parsing JSON → liste de fichiers à modifier
  ├─ écriture des fichiers (path traversal bloqué)
  ├─ npm install (si package.json modifié)
  ├─ npm run build
  │   ├─ KO → git checkout -- . + embed ❌
  │   └─ OK → git add . + commit + push + embed ✅
  └─ fin
```
