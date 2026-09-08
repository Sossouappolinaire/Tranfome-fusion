// config.js
// Centralise toutes les variables d'environnement liées aux API FusionMoney
// (MoneyFusion) — payin (encaissement) et payout (envoi). Toutes les valeurs
// sensibles doivent être définies dans les variables d'environnement de
// votre hébergeur (jamais commitées dans git).

require('dotenv').config();
const crypto = require('crypto');

// Si WEBHOOK_SECRET n'est pas fourni en variable d'environnement, on en
// génère un automatiquement au démarrage (32 octets aléatoires). Comme les
// transferts en cours sont déjà stockés en mémoire (perdus au redémarrage,
// voir server.js), un secret généré en mémoire ne change rien niveau
// robustesse : il vit exactement aussi longtemps que les transferts qu'il
// protège. Définissez WEBHOOK_SECRET vous-même seulement si vous voulez une
// valeur stable entre redémarrages.
const AUTO_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

const config = {
  // Port sur lequel le serveur Express écoute.
  // Sur Render/Railway/etc., la plateforme fournit process.env.PORT ;
  // 10000 est utilisé en repli local.
  port: process.env.PORT || 10000,

  fusionMoney: {
    // URL de base de l'API Payout FusionMoney (voir docs.moneyfusion.net/fr/payout).
    baseUrl: process.env.FUSIONMONEY_BASE_URL || 'https://pay.moneyfusion.net/api/v1',

    // URL de l'API Payin (encaissement), propre à CHAQUE marchand — à
    // récupérer depuis votre tableau de bord FusionMoney (section API Web /
    // Payin). Sans elle, impossible d'encaisser chez l'expéditeur.
    payinUrl: process.env.FUSIONMONEY_PAYIN_URL || '',

    // Clé API privée générée depuis votre tableau de bord MoneyFusion
    // (section Paramètres). Requise pour l'en-tête "moneyfusion-private-key"
    // du PAYOUT uniquement (le payin n'en a pas besoin).
    // ⚠️ L'IP publique de ce serveur doit être ajoutée dans votre dashboard
    // MoneyFusion, sinon les requêtes de retrait (payout) seront rejetées.
    privateKey: process.env.FUSIONMONEY_PRIVATE_KEY || '',

    // URL publique de ce service, utilisée pour construire le webhook_url et
    // le return_url envoyés à MoneyFusion (ex: https://votre-app.onrender.com).
    // Auto-détectée sur Render via RENDER_EXTERNAL_URL (fournie automatiquement
    // par la plateforme à chaque service web, pas besoin de la définir à la
    // main) ; PUBLIC_BASE_URL reste disponible pour la forcer manuellement
    // (autre hébergeur, domaine personnalisé, test local).
    publicBaseUrl: process.env.PUBLIC_BASE_URL
      || process.env.RENDER_EXTERNAL_URL
      || `http://localhost:${process.env.PORT || 10000}`,

    // Jeton secret ajouté en paramètre de requête aux webhooks (?key=...)
    // afin de vérifier que les notifications proviennent bien de votre
    // propre appel et pas d'un tiers. MoneyFusion ne documentant pas de
    // signature HMAC pour ses webhooks, ce jeton "partagé" est la
    // protection minimale mise en place ici.
    // Fourni par WEBHOOK_SECRET si défini, sinon généré automatiquement au
    // démarrage (voir AUTO_WEBHOOK_SECRET ci-dessus) — aucune action requise.
    webhookSecret: process.env.WEBHOOK_SECRET || AUTO_WEBHOOK_SECRET,
  },
};

if (!config.fusionMoney.privateKey) {
  console.warn('⚠️  FUSIONMONEY_PRIVATE_KEY manquante : les envois (payout) échoueront tant qu\'elle n\'est pas définie.');
}
if (!config.fusionMoney.payinUrl) {
  console.warn('⚠️  FUSIONMONEY_PAYIN_URL manquante : l\'encaissement (payin) chez l\'expéditeur échouera tant qu\'elle n\'est pas définie.');
}

// --- Vérification des variables d'environnement (utile juste après un ---
// --- déploiement sur Render, pour confirmer que tout est bien chargé) ---
//
// Chaque variable est classée "required" (le service ne peut pas
// fonctionner correctement sans elle) ou "optional" (une valeur par défaut
// existe). Les valeurs elles-mêmes ne sont jamais affichées/renvoyées —
// seulement le fait qu'elles soient définies ou non — pour ne jamais faire
// fuiter de secret dans les logs Render ou la réponse HTTP.
const ENV_VARS = [
  { key: 'FUSIONMONEY_PRIVATE_KEY', required: true, note: 'nécessaire pour le PAYOUT (retrait vers le destinataire)' },
  { key: 'FUSIONMONEY_PAYIN_URL', required: true, note: "nécessaire pour le PAYIN (encaissement de l'expéditeur)" },
  { key: 'FUSIONMONEY_BASE_URL', required: false, note: 'a une valeur par défaut correcte, à ne changer que si FusionMoney vous en donne une autre' },
  { key: 'PORT', required: false, note: 'fourni automatiquement par Render' },
  { key: 'RENDER_EXTERNAL_URL', required: false, note: "fournie automatiquement par Render (sert de PUBLIC_BASE_URL) ; absente en local ou hors Render, c'est normal — voir 'URL publique utilisée' ci-dessous" },
  { key: 'WEBHOOK_SECRET', required: false, note: "générée automatiquement au démarrage si absente (voir 'Secret webhook' ci-dessous) ; à définir vous-même seulement pour une valeur stable entre redémarrages" },
];

/**
 * Construit un rapport de l'état des variables d'environnement, sans
 * jamais exposer leur valeur. Utilisé au démarrage (logs) et par la route
 * GET /api/health (voir server.js).
 */
function checkEnvVars() {
  const vars = ENV_VARS.map((v) => ({
    key: v.key,
    required: v.required,
    loaded: Boolean(process.env[v.key] && String(process.env[v.key]).trim() !== ''),
    note: v.note,
  }));
  const missingRequired = vars.filter((v) => v.required && !v.loaded).map((v) => v.key);
  return {
    ok: missingRequired.length === 0,
    missingRequired,
    // L'URL publique réellement utilisée (celle envoyée à FusionMoney comme
    // webhook_url / return_url) — pas une simple variable d'env, donc affichée
    // à part : c'est la vraie valeur, pas juste "chargée ou non".
    publicBaseUrlInUse: config.fusionMoney.publicBaseUrl,
    // Indique seulement la SOURCE du secret webhook (jamais sa valeur) :
    // "env" = vous l'avez fourni vous-même, "auto-generated" = généré tout
    // seul au démarrage. Dans les deux cas, les webhooks sont protégés.
    webhookSecretSource: process.env.WEBHOOK_SECRET ? 'env' : 'auto-generated',
    vars,
  };
}

/**
 * Affiche un résumé lisible dans les logs (Render > onglet "Logs") juste
 * après le démarrage du serveur, pour confirmer d'un coup d'œil que les
 * variables d'environnement ont bien été chargées.
 */
function logEnvStatus() {
  const report = checkEnvVars();
  console.log('\n--- Vérification des variables d\'environnement ---');
  report.vars.forEach((v) => {
    const icon = v.loaded ? '✅' : (v.required ? '❌' : '⚠️ ');
    const tag = v.required ? 'requise' : 'optionnelle';
    console.log(`${icon} ${v.key} (${tag}) — ${v.loaded ? 'chargée' : 'absente'} — ${v.note}`);
  });
  if (report.ok) {
    console.log('✅ Toutes les variables requises sont chargées.');
  } else {
    console.log(`❌ Variables requises manquantes : ${report.missingRequired.join(', ')}`);
    console.log('   -> Sur Render : Dashboard du service > Environment > Add Environment Variable, puis redéployez.');
  }
  console.log(`ℹ️  URL publique utilisée (webhook_url / return_url) : ${report.publicBaseUrlInUse}`);
  if (report.publicBaseUrlInUse.startsWith('http://localhost')) {
    console.log("   ⚠️  Ceci ressemble à une adresse locale — sur Render, RENDER_EXTERNAL_URL devrait être fournie automatiquement. Si ce message apparaît en production, définissez PUBLIC_BASE_URL manuellement.");
  }
  console.log(`🔑 Secret webhook : ${report.webhookSecretSource === 'env' ? 'fourni via WEBHOOK_SECRET' : 'généré automatiquement au démarrage'} (valeur jamais affichée).`);
  console.log('--- Fin de la vérification ---\n');
  return report;
}

module.exports = config;
module.exports.checkEnvVars = checkEnvVars;
module.exports.logEnvStatus = logEnvStatus;
