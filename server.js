// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API de
// transfert réseau -> réseau, qui combine les DEUX API FusionMoney :
//
//   1) PAYIN  : on encaisse chez l'EXPÉDITEUR (redirection vers la page de
//               paiement FusionMoney, il valide avec son propre Mobile
//               Money).
//   2) Webhook payin.session.completed : dès que l'encaissement est
//               confirmé, on déclenche AUTOMATIQUEMENT le PAYOUT vers le
//               DESTINATAIRE.
//   3) Webhook payout.session.completed / .cancelled : confirme (ou non)
//               l'arrivée de l'argent chez le destinataire.
//
// Flux complet d'un transfert :
//   1) GET  /api/methods           -> liste (mise en cache) des pays/réseaux
//                                      disponibles pour le PAYOUT (destinataire).
//   2) POST /api/transfer          -> crée le transfert, lance le PAYIN chez
//                                      l'expéditeur, renvoie l'URL de paiement
//                                      FusionMoney vers laquelle rediriger.
//   3) POST /api/webhook/payin     -> FusionMoney confirme l'encaissement ->
//                                      on lance alors le PAYOUT.
//   4) POST /api/webhook/payout    -> FusionMoney confirme (ou non) l'envoi
//                                      au destinataire.
//   5) GET  /api/transfer/:id      -> le front-end interroge l'état (polling)
//                                      une fois l'expéditeur revenu du paiement.
//
// ⚠️ Point d'attention (à surveiller en production) : si le PAYIN réussit
// mais que le PAYOUT échoue ensuite (réseau destinataire indisponible,
// solde marchand insuffisant, etc.), l'argent a déjà été prélevé chez
// l'expéditeur sans être arrivé chez le destinataire. Le statut du
// transfert passe alors à "payout_failed" : à vous de mettre en place soit
// un remboursement, soit une nouvelle tentative de payout, soit un suivi
// manuel — FusionMoney ne le fait pas automatiquement.

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const config = require('./config');
const fusionMoney = require('./fusionMoneyService');
const { getPhoneRule } = require('./phoneRules');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Stockage en mémoire des transferts (suffisant pour une démo ; utilisez une
// vraie base de données en production — l'état est perdu à chaque
// redémarrage/redéploiement).
const transfers = new Map(); // transferId -> transfer
const payinTokenIndex = new Map(); // payinToken -> transferId
const payoutTokenIndex = new Map(); // payoutToken -> transferId

// --- Cache de la liste des pays / réseaux disponibles (PAYOUT) ---------
let methodsCache = { data: [], fetchedAt: 0 };
const METHODS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getMethods({ forceRefresh = false } = {}) {
  const isStale = Date.now() - methodsCache.fetchedAt > METHODS_CACHE_TTL_MS;
  if (forceRefresh || isStale || methodsCache.data.length === 0) {
    const data = await fusionMoney.getWithdrawMethods();
    methodsCache = { data, fetchedAt: Date.now() };
  }
  return methodsCache.data;
}

function findMethod(countries, countryCode, withdrawMode) {
  const country = countries.find((c) => c.code === countryCode);
  if (!country) return null;
  const method = (country.paymentMethods || []).find((m) => m.key === withdrawMode);
  if (!method) return null;
  return { country, method };
}

function webhookUrlFor(name) {
  const base = `${config.fusionMoney.publicBaseUrl}/api/webhook/${name}`;
  return config.fusionMoney.webhookSecret
    ? `${base}?key=${encodeURIComponent(config.fusionMoney.webhookSecret)}`
    : base;
}

function checkWebhookKey(req, res) {
  if (config.fusionMoney.webhookSecret && req.query.key !== config.fusionMoney.webhookSecret) {
    console.warn('Webhook FusionMoney : jeton de vérification invalide, requête ignorée.');
    res.sendStatus(401);
    return false;
  }
  return true;
}

// Liste des pays et réseaux Mobile Money pris en charge par le PAYOUT (pour
// peupler le formulaire "destinataire" côté front-end, sans clé API requise
// côté client).
app.get('/api/methods', async (req, res) => {
  try {
    const data = await getMethods();
    const enriched = data.map((country) => ({
      ...country,
      phoneRule: getPhoneRule(country.code),
    }));
    return res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Erreur récupération des méthodes FusionMoney :', error.message);
    return res.status(502).json({ success: false, message: "Impossible de récupérer la liste des réseaux disponibles." });
  }
});

// --- Étape 1 : créer le transfert et lancer le PAYIN chez l'expéditeur --
app.post('/api/transfer', async (req, res) => {
  const { senderPhone, senderName, countryCode, withdrawMode, phone, amount } = req.body;

  if (!senderPhone || !senderName) {
    return res.status(400).json({ success: false, message: 'senderPhone et senderName sont requis.' });
  }
  if (!countryCode || !withdrawMode || !phone || !amount) {
    return res.status(400).json({
      success: false,
      message: 'countryCode, withdrawMode, phone et amount (destinataire) sont requis.',
    });
  }
  if (Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Montant invalide.' });
  }

  try {
    const countries = await getMethods();
    const match = findMethod(countries, countryCode, withdrawMode);
    if (!match) {
      return res.status(400).json({
        success: false,
        message: 'Pays ou réseau non reconnu. Merci de resélectionner un réseau dans la liste.',
      });
    }

    const digitsOnly = String(phone).replace(/\D/g, '');
    const rule = getPhoneRule(countryCode);
    if (rule && digitsOnly.length !== rule.digits) {
      return res.status(400).json({
        success: false,
        message: `Numéro invalide pour ${match.country.country} : ${rule.digits} chiffres attendus (ex : ${rule.example}).`,
      });
    }
    if (!rule && (digitsOnly.length < 6 || digitsOnly.length > 12)) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone (destinataire) invalide.' });
    }

    const senderDigitsOnly = String(senderPhone).replace(/\D/g, '');
    if (senderDigitsOnly.length < 6 || senderDigitsOnly.length > 12) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone (expéditeur) invalide.' });
    }

    const transferId = crypto.randomUUID();

    const transfer = {
      transferId,
      stage: 'payin_pending', // payin_pending -> payin_failed | payout_pending -> completed | payout_failed
      message: 'En attente du paiement de l\'expéditeur.',
      sender: { phone: senderDigitsOnly, name: senderName },
      recipient: {
        countryCode,
        countryName: match.country.country,
        currency: match.country.currency,
        withdrawMode,
        networkName: match.method.name,
        phone: digitsOnly,
        amount: Number(amount),
      },
      payinToken: null,
      payoutToken: null,
      createdAt: new Date().toISOString(),
    };
    transfers.set(transferId, transfer);

    // NOTE : FusionMoney prélève des frais côté payin (champ "frais" dans le
    // webhook / la vérification de statut). Ce montant n'est pas déduit ici
    // du montant envoyé au destinataire : le destinataire reçoit exactement
    // `amount`. Si vous voulez répercuter les frais sur l'expéditeur,
    // augmentez le totalPrice du payin en conséquence.
    const payinResult = await fusionMoney.initiatePayin({
      amount,
      senderPhone: senderDigitsOnly,
      senderName,
      personalInfo: { transferId },
      returnUrl: `${config.fusionMoney.publicBaseUrl}/?transferId=${transferId}`,
      webhookUrl: webhookUrlFor('payin'),
    });

    transfer.payinToken = payinResult.token;
    payinTokenIndex.set(payinResult.token, transferId);

    return res.json({
      success: true,
      transferId,
      paymentUrl: payinResult.url,
      message: payinResult.message || 'Redirection vers le paiement...',
    });
  } catch (error) {
    console.error('Erreur création transfert (payin) :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
    });
  }
});

// --- Étape 2 : suivi (polling) d'un transfert par le front-end ----------
app.get('/api/transfer/:transferId', (req, res) => {
  const transfer = transfers.get(req.params.transferId);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  }
  return res.json({ success: true, transfer });
});

// --- Webhook PAYIN : encaissement chez l'expéditeur ----------------------
app.post('/api/webhook/payin', (req, res) => {
  if (!checkWebhookKey(req, res)) return;

  // Répondre 200 immédiatement ; le reste du traitement continue ensuite.
  res.sendStatus(200);

  const body = req.body || {};
  const { event, tokenPay, personal_Info } = body;
  console.log('Webhook PAYIN FusionMoney reçu :', body);

  const transferId = (personal_Info && personal_Info[0] && personal_Info[0].transferId)
    || payinTokenIndex.get(tokenPay);
  const transfer = transferId ? transfers.get(transferId) : null;
  if (!transfer) return; // référence inconnue

  if (!transfer.payinToken) {
    transfer.payinToken = tokenPay;
    payinTokenIndex.set(tokenPay, transfer.transferId);
  }

  if (event === 'payin.session.completed') {
    // L'argent est encaissé chez l'expéditeur : on déclenche le PAYOUT.
    triggerPayout(transfer).catch((err) => {
      console.error('Erreur déclenchement payout après payin :', err.message);
      transfer.stage = 'payout_failed';
      transfer.message = "Paiement reçu, mais l'envoi au destinataire n'a pas pu être lancé. Contactez le support.";
    });
  } else if (event === 'payin.session.cancelled') {
    transfer.stage = 'payin_failed';
    transfer.message = "Le paiement de l'expéditeur a échoué ou a été annulé.";
  } else if (event === 'payin.session.pending') {
    transfer.stage = 'payin_pending';
    transfer.message = 'Paiement en cours de traitement...';
  }
});

async function triggerPayout(transfer) {
  transfer.stage = 'payout_pending';
  transfer.message = 'Paiement reçu, envoi au destinataire en cours...';

  const payoutResult = await fusionMoney.initiateWithdraw({
    countryCode: transfer.recipient.countryCode,
    phone: transfer.recipient.phone,
    amount: transfer.recipient.amount,
    withdrawMode: transfer.recipient.withdrawMode,
    webhookUrl: webhookUrlFor('payout'),
  });

  transfer.payoutToken = payoutResult.tokenPay;
  payoutTokenIndex.set(payoutResult.tokenPay, transfer.transferId);
}

// --- Webhook PAYOUT : envoi vers le destinataire -------------------------
app.post('/api/webhook/payout', (req, res) => {
  if (!checkWebhookKey(req, res)) return;

  res.sendStatus(200);

  const body = req.body || {};
  const { event, tokenPay } = body;
  console.log('Webhook PAYOUT FusionMoney reçu :', body);

  const transferId = payoutTokenIndex.get(tokenPay);
  const transfer = transferId ? transfers.get(transferId) : null;
  if (!transfer) return; // référence inconnue

  if (event === 'payout.session.completed') {
    transfer.stage = 'completed';
    transfer.message = 'Transfert terminé avec succès.';
  } else if (event === 'payout.session.cancelled') {
    transfer.stage = 'payout_failed';
    transfer.message = "Paiement reçu chez l'expéditeur, mais l'envoi au destinataire a échoué ou a été annulé. Contactez le support pour un remboursement ou une nouvelle tentative.";
  }
});

// Route de vérification post-déploiement : à ouvrir dans le navigateur
// (https://votre-service.onrender.com/api/health) pour confirmer que les
// variables d'environnement sont bien chargées sur Render. Ne renvoie
// jamais les valeurs elles-mêmes, seulement si chaque variable est définie.
app.get('/api/health', (req, res) => {
  const report = config.checkEnvVars();
  return res.status(report.ok ? 200 : 500).json(report);
});

app.listen(config.port, () => {
  console.log(`Serveur lancé sur le port ${config.port}`);
  config.logEnvStatus();
});
