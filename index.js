require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const simpleGit = require('simple-git');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const AUTHORIZED_IDS = (process.env.AUTHORIZED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const WORKDIR     = path.resolve(process.env.WORKDIR || './workspace');
const GITHUB_REPO = process.env.GITHUB_REPO;         // ex: "username/mon-repo"
const GH_TOKEN    = process.env.GITHUB_TOKEN;

if (!process.env.DISCORD_TOKEN)    throw new Error('DISCORD_TOKEN manquant');
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquant');
if (!GH_TOKEN)                      throw new Error('GITHUB_TOKEN manquant');
if (!GITHUB_REPO)                   throw new Error('GITHUB_REPO manquant');
if (AUTHORIZED_IDS.length === 0)    throw new Error('AUTHORIZED_USER_IDS manquant');

// ─── Clients ──────────────────────────────────────────────────────────────────

const discord   = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers Discord ──────────────────────────────────────────────────────────

function embed(title, description, color = 0x5865f2) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

async function setStatus(msg, title, description, color) {
  await msg.edit({ embeds: [embed(title, description, color)] });
}

// ─── Helpers fichiers ─────────────────────────────────────────────────────────

const IGNORED_DIRS  = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '__pycache__']);
const SOURCE_EXTS   = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.html', '.json', '.md', '.env.example', '.toml', '.yaml', '.yml']);
const IGNORED_FILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', '.env']);

function walkTree(dir, prefix = '') {
  const lines = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return lines; }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry) || IGNORED_FILES.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      lines.push(`${prefix}${entry}/`);
      lines.push(...walkTree(fullPath, prefix + '  '));
    } else {
      lines.push(`${prefix}${entry}`);
    }
  }
  return lines;
}

function collectSourceFiles(dir, maxFiles = 40) {
  const files = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || IGNORED_FILES.has(entry)) continue;
      const fullPath = path.join(d, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (SOURCE_EXTS.has(path.extname(entry)) || SOURCE_EXTS.has(entry)) {
        files.push(fullPath);
      }
    }
  }
  walk(dir);
  // Priorité : src/ en premier, puis le reste
  const src   = files.filter((f) => f.replace(dir, '').startsWith(path.sep + 'src'));
  const other = files.filter((f) => !f.replace(dir, '').startsWith(path.sep + 'src'));
  return [...src, ...other].slice(0, maxFiles);
}

function readSafe(filePath, maxBytes = 60_000) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > maxBytes ? raw.slice(0, maxBytes) + '\n/* … [tronqué] */' : raw;
  } catch {
    return null;
  }
}

// ─── Parse réponse Claude ─────────────────────────────────────────────────────

function parseChanges(text) {
  // Cherche un bloc ```json ... ```
  const jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1]); } catch { /* continue */ }
  }
  // Cherche un tableau JSON brut
  const rawArray = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (rawArray) {
    try { return JSON.parse(rawArray[0]); } catch { /* continue */ }
  }
  return null;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function runDevPipeline(request, statusMsg) {
  // 1. Clone ou pull
  console.log('[STEP 1] Sync repo…');
  await setStatus(statusMsg, '📥 Repo', `Synchronisation de \`${GITHUB_REPO}\`…`);

  const repoUrl = `https://${GH_TOKEN}@github.com/${GITHUB_REPO}.git`;

  if (!fs.existsSync(WORKDIR)) fs.mkdirSync(WORKDIR, { recursive: true });

  const git = simpleGit(WORKDIR);

  if (!fs.existsSync(path.join(WORKDIR, '.git'))) {
    await setStatus(statusMsg, '📥 Clone', `Premier clonage de \`${GITHUB_REPO}\`…`);
    console.log('[STEP 1] Clonage…');
    await git.clone(repoUrl, '.', ['--depth=1']);
  } else {
    await setStatus(statusMsg, '🔄 Pull', `Mise à jour depuis \`origin/main\`…`);
    console.log('[STEP 1] Pull…');
    await git.remote(['set-url', 'origin', repoUrl]);
    await git.pull('origin', 'main');
  }
  console.log('[STEP 1] Repo OK');

  // Config git pour le commit
  await git.addConfig('user.name', 'Discord Dev Bot');
  await git.addConfig('user.email', 'bot@discord-dev.local');

  // 2. Construire le contexte pour Claude
  console.log('[STEP 2] Lecture fichiers…');
  await setStatus(statusMsg, '🔍 Analyse', `Lecture du repo…`);

  const tree  = walkTree(WORKDIR).join('\n');
  const files = collectSourceFiles(WORKDIR, 20); // réduit à 20 fichiers max

  let filesContext = '';
  for (const filePath of files) {
    const rel     = path.relative(WORKDIR, filePath);
    const content = readSafe(filePath, 30_000); // max 30kb par fichier
    if (content) filesContext += `\n\n### ${rel}\n\`\`\`\n${content}\n\`\`\``;
  }
  console.log(`[STEP 2] ${files.length} fichiers lus`);

  // 3. Appel Claude
  console.log('[STEP 3] Appel Claude Sonnet…');
  await setStatus(statusMsg, '🧠 Claude', `Génération des modifications… _(peut prendre 20-40s)_`);

  const system = `Tu es un expert développeur React / TypeScript / Vite / Tailwind.
Tu travailles sur le projet dont la structure et les fichiers sources sont fournis ci-dessous.

STRUCTURE DU PROJET :
\`\`\`
${tree}
\`\`\`

FICHIERS SOURCES ACTUELS :${filesContext}

RÈGLES STRICTES :
1. Réponds UNIQUEMENT avec un tableau JSON — rien d'autre avant ni après.
2. Format exact :
\`\`\`json
[
  {
    "path": "src/components/MonComposant.tsx",
    "content": "...contenu complet du fichier..."
  }
]
\`\`\`
3. Chaque fichier doit être COMPLET (pas de "...", pas de parties omises).
4. Respecte exactement les conventions du projet (imports, style, nommage).
5. Si tu crées un nouveau fichier, inclus-le. Si tu modifies un fichier, retourne-le entier.
6. Ne modifie que ce qui est nécessaire pour répondre à la demande.`;

  const response = await anthropic.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 8192,
    system,
    messages:   [{ role: 'user', content: request }],
  });
  console.log('[STEP 3] Claude OK');

  const claudeText = response.content[0]?.text ?? '';
  const changes    = parseChanges(claudeText);

  if (!changes || changes.length === 0) {
    throw new Error(
      `Claude n'a pas retourné de JSON valide.\n\nRéponse brute :\n${claudeText.slice(0, 800)}`
    );
  }

  // 4. Appliquer les modifications
  await setStatus(
    statusMsg,
    '✏️ Modifications',
    `Application de **${changes.length}** fichier(s)…`,
  );

  const modifiedPaths = [];
  for (const { path: relPath, content } of changes) {
    // Sécurité : interdit les chemins qui remontent hors du WORKDIR
    const abs = path.resolve(WORKDIR, relPath);
    if (!abs.startsWith(WORKDIR)) throw new Error(`Chemin interdit : ${relPath}`);

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    modifiedPaths.push(relPath);
  }

  // 5. npm install si package.json a changé
  if (modifiedPaths.some((p) => p === 'package.json')) {
    await setStatus(statusMsg, '📦 npm install', `Installation des nouvelles dépendances…`);
    execSync('npm install', { cwd: WORKDIR, stdio: 'pipe', timeout: 120_000 });
  }

  // 6. Build
  await setStatus(statusMsg, '🔨 Build', `\`npm run build\` en cours…`);

  let buildLog = '';
  let buildOk  = false;

  try {
    buildLog = execSync('npm run build', {
      cwd:     WORKDIR,
      stdio:   'pipe',
      timeout: 180_000,
    }).toString();
    buildOk = true;
  } catch (err) {
    buildLog = (err.stderr?.toString() || err.stdout?.toString() || err.message).slice(0, 1800);
  }

  // 7a. Build KO → revert + signalement
  if (!buildOk) {
    await git.checkout(['--', '.']);
    await setStatus(
      statusMsg,
      '❌ Build échoué — modifications annulées',
      `**Erreur :**\n\`\`\`\n${buildLog}\n\`\`\``,
      0xff0000,
    );
    return;
  }

  // 7b. Build OK → commit + push
  await setStatus(statusMsg, '🚀 Push', `Build OK — commit & push vers \`main\`…`);

  const commitMsg = `feat: ${request.slice(0, 72)} [bot]`;
  await git.add('.');
  await git.commit(commitMsg);
  await git.push('origin', 'main');

  const fileList = modifiedPaths.map((p) => `• \`${p}\``).join('\n');
  await setStatus(
    statusMsg,
    '✅ Déployé avec succès !',
    `**Demande :** ${request}\n\n**Fichiers modifiés (${modifiedPaths.length}) :**\n${fileList}\n\n**Build :** OK\n**Commit :** \`${commitMsg}\`\n**Push :** → \`origin/main\``,
    0x57f287,
  );
}

// ─── Event handlers ───────────────────────────────────────────────────────────

discord.on('messageCreate', async (message) => {
  console.log(`[MSG] ${message.author.tag} : ${message.content}`);
  if (message.author.bot)                    return;
  if (!message.content.startsWith('!dev '))  return;

  // Vérification autorisation
  if (!AUTHORIZED_IDS.includes(message.author.id)) {
    await message.reply({ embeds: [embed('⛔ Non autorisé', 'Ton ID Discord n\'est pas dans `AUTHORIZED_USER_IDS`.', 0xed4245)] });
    return;
  }

  const request = message.content.slice(5).trim();
  if (!request) {
    await message.reply({ embeds: [embed('ℹ️ Usage', '`!dev [ta demande en langage naturel]`\n\nExemple : `!dev ajoute une section pricing sur la landing page`')] });
    return;
  }

  // Message de statut initial (sera mis à jour tout au long du pipeline)
  const statusMsg = await message.reply({
    embeds: [embed('🤖 Dev Agent démarré', `**Demande :** ${request}\n\n⏳ Démarrage du pipeline…`)],
  });

  try {
    await runDevPipeline(request, statusMsg);
  } catch (err) {
    console.error('[ERROR]', err);
    await setStatus(
      statusMsg,
      '❌ Erreur inattendue',
      `\`\`\`\n${String(err.message || err).slice(0, 1500)}\n\`\`\``,
      0xff0000,
    ).catch(() => {});
  }
});

discord.once('ready', () => {
  console.log(`[BOT] Connecté en tant que ${discord.user.tag}`);
  console.log(`[BOT] IDs autorisés : ${AUTHORIZED_IDS.join(', ')}`);
  console.log(`[BOT] Repo cible    : ${GITHUB_REPO}`);
  console.log(`[BOT] WORKDIR       : ${WORKDIR}`);
});

discord.login(process.env.DISCORD_TOKEN);
