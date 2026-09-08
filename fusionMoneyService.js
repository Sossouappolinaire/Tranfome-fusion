// fusionMoneyService.js
// Wrapper autour des DEUX API de FusionMoney (MoneyFusion) nécessaires pour
// un vrai transfert « réseau à réseau » (encaissement chez l'expéditeur PUIS
// renvoi au destinataire) :
//
//   PAYIN  (docs.moneyfusion.net/fr/webapi) — encaisse l'argent chez
//          l'expéditeur : on redirige son navigateur vers une page de
//          paiement hébergée par FusionMoney, où il valide avec son propre
//          Mobile Money. Confirmation par webhook (payin.session.completed).
//
//   PAYOUT (docs.moneyfusion.net/fr/payout) — une fois l'encaissement
//          confirmé, envoie l'argent vers le destinataire (pays + réseau +
//          numéro). Confirmation par webhook (payout.session.completed /
//          payout.session.cancelled).
//
// Voir server.js pour l'orchestration complète (payin -> webhook -> payout).

const config = require('./config');

const PAYOUT_BASE_URL = config.fusionMoney.baseUrl; // https://pay.moneyfusion.net/api/v1
const PAYIN_STATUS_BASE_URL = 'https://pay.moneyfusion.net/paiementNotif';

async function callFusionMoney(method, url, { body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['moneyfusion-private-key'] = config.fusionMoney.privateKey;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.statut === false || json.success === false) {
    const err = new Error(json.message || `Erreur FusionMoney (HTTP ${response.status})`);
    err.code = 'FUSIONMONEY_ERROR';
    err.raw = json;
    throw err;
  }

  return json;
}

// ------------------------------------------------------------------------
// PAYIN — encaissement chez l'expéditeur
// ------------------------------------------------------------------------

/**
 * Initie une demande de paiement (encaissement) chez l'expéditeur.
 * POST vers l'URL "apiUrl" propre au marchand (récupérée depuis le
 * tableau de bord FusionMoney — voir FUSIONMONEY_PAYIN_URL dans .env).
 * Réponse : { statut, token, message, url } — "url" est la page de
 * paiement FusionMoney vers laquelle rediriger l'expéditeur.
 */
async function initiatePayin({ amount, senderPhone, senderName, webhookUrl, returnUrl, personalInfo }) {
  if (!config.fusionMoney.payinUrl) {
    const err = new Error("URL de l'API Payin non configurée (FUSIONMONEY_PAYIN_URL manquante).");
    err.code = 'PAYIN_URL_MISSING';
    throw err;
  }

  const payload = {
    totalPrice: Number(amount),
    article: [{ transfert: Number(amount) }],
    numeroSend: senderPhone,
    nomclient: senderName,
  };
  if (personalInfo) payload.personal_Info = [personalInfo];
  if (returnUrl) payload.return_url = returnUrl;
  if (webhookUrl) payload.webhook_url = webhookUrl;

  return callFusionMoney('POST', config.fusionMoney.payinUrl, { body: payload });
}

/**
 * Vérifie l'état d'un paiement (encaissement) directement auprès de
 * FusionMoney — utile en secours si un webhook payin a été manqué.
 * GET https://pay.moneyfusion.net/paiementNotif/:token
 */
async function checkPayinStatus(token) {
  return callFusionMoney('GET', `${PAYIN_STATUS_BASE_URL}/${encodeURIComponent(token)}`);
}

// ------------------------------------------------------------------------
// PAYOUT — envoi vers le destinataire
// ------------------------------------------------------------------------

/**
 * Récupère la liste dynamique des pays et méthodes de retrait disponibles.
 * GET /withdraw/methods
 * Renvoie un tableau : [{ country, code, currency, paymentMethods: [{key, name}] }, ...]
 */
async function getWithdrawMethods() {
  const json = await callFusionMoney('GET', `${PAYOUT_BASE_URL}/withdraw/methods`);
  return json.data || [];
}

/**
 * Initie un retrait (envoi) Mobile Money vers un destinataire.
 * POST /withdraw
 * Requiert l'en-tête moneyfusion-private-key (IP serveur autorisée côté
 * dashboard MoneyFusion).
 */
async function initiateWithdraw({ countryCode, phone, amount, withdrawMode, webhookUrl }) {
  const payload = {
    countryCode,
    phone,
    amount: Number(amount),
    withdraw_mode: withdrawMode,
  };
  if (webhookUrl) payload.webhook_url = webhookUrl;

  return callFusionMoney('POST', `${PAYOUT_BASE_URL}/withdraw`, { body: payload, auth: true });
}

module.exports = {
  initiatePayin,
  checkPayinStatus,
  getWithdrawMethods,
  initiateWithdraw,
};
