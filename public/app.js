// app.js
// Charge dynamiquement la liste des pays/réseaux depuis /api/methods, gère
// la soumission du formulaire, puis suit (polling) l'état du transfert
// jusqu'à confirmation. N'appelle jamais FusionMoney directement : passe
// toujours par notre backend, qui seul détient la clé API.

const senderNameInput = document.getElementById('sender-name');
const senderPhoneInput = document.getElementById('sender-phone');
const countrySelect = document.getElementById('country');
const networkGrid = document.getElementById('network-grid');
const phoneInput = document.getElementById('phone');
const phoneHint = document.getElementById('phone-hint');
const amountInput = document.getElementById('amount');
const currencyTag = document.getElementById('currency-tag');
const form = document.getElementById('transfer-form');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');

const panelForm = document.getElementById('panel-form');
const panelStatus = document.getElementById('panel-status');
const statusRing = document.getElementById('status-ring');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const newTransferBtn = document.getElementById('new-transfer-btn');

const summaryPhone = document.getElementById('summary-phone');
const summaryNetwork = document.getElementById('summary-network');
const summaryAmount = document.getElementById('summary-amount');
const summaryToken = document.getElementById('summary-token');

const stepItems = {
  form: document.querySelector('.steps__item[data-step="form"]'),
  pending: document.querySelector('.steps__item[data-step="pending"]'),
  done: document.querySelector('.steps__item[data-step="done"]'),
};

let countriesData = [];
let selectedCountry = null;
let selectedMethod = null; // { key, name }

// Couleurs indicatives par opérateur (pas des logos officiels — un simple
// repère visuel construit côté client à partir du nom renvoyé par l'API).
const OPERATOR_COLORS = [
  { match: /mtn/i, bg: '#FFCC00', fg: '#16241f' },
  { match: /orange/i, bg: '#FF6600', fg: '#ffffff' },
  { match: /moov/i, bg: '#0072CE', fg: '#ffffff' },
  { match: /wave/i, bg: '#1DC8CD', fg: '#0b2b2c' },
  { match: /airtel/i, bg: '#E4022D', fg: '#ffffff' },
  { match: /^free/i, bg: '#8710D8', fg: '#ffffff' },
  { match: /celtiis/i, bg: '#00A19A', fg: '#ffffff' },
  { match: /card|visa|mastercard/i, bg: '#16241f', fg: '#ffffff' },
];
const DEFAULT_OPERATOR_COLOR = { bg: '#1B6B63', fg: '#ffffff' };

function operatorColor(name) {
  const found = OPERATOR_COLORS.find((o) => o.match.test(name));
  return found || DEFAULT_OPERATOR_COLOR;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStep(step, variant) {
  Object.values(stepItems).forEach((el) => el.classList.remove('is-active', 'is-done', 'is-failed'));
  if (step === 'form') {
    stepItems.form.classList.add('is-active');
  } else if (step === 'pending') {
    stepItems.form.classList.add('is-done');
    stepItems.pending.classList.add('is-active');
  } else if (step === 'done') {
    stepItems.form.classList.add('is-done');
    stepItems.pending.classList.add(variant === 'failed' ? 'is-failed' : 'is-done');
    stepItems.done.classList.add(variant === 'failed' ? 'is-failed' : 'is-done');
  }
}

// --- Chargement des pays / réseaux disponibles -------------------------

async function loadMethods() {
  try {
    const response = await fetch('/api/methods');
    const data = await response.json();

    if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error('Liste vide');
    }

    countriesData = data.data;
    countrySelect.innerHTML = '<option value="">Sélectionnez un pays</option>' +
      countriesData
        .map((c) => `<option value="${c.code}">${c.country}</option>`)
        .join('');
    countrySelect.disabled = false;
  } catch (err) {
    countrySelect.innerHTML = '<option value="">Réseaux indisponibles pour le moment</option>';
    formError.textContent = "Impossible de charger la liste des pays. Réessayez dans un instant.";
  }
}

function renderNetworkChips(country) {
  selectedMethod = null;

  if (!country || !(country.paymentMethods || []).length) {
    networkGrid.innerHTML = '<p class="hint">Sélectionnez d\'abord un pays.</p>';
    return;
  }

  networkGrid.innerHTML = '';
  country.paymentMethods.forEach((method) => {
    const color = operatorColor(method.name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'network-chip';
    chip.dataset.key = method.key;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    chip.innerHTML = `
      <span class="network-chip__badge" style="background:${color.bg};color:${color.fg}">${method.name.charAt(0).toUpperCase()}</span>
      <span class="network-chip__name">${method.name}</span>
    `;
    chip.addEventListener('click', () => selectNetwork(method, chip));
    networkGrid.appendChild(chip);
  });
}

function selectNetwork(method, chipEl) {
  selectedMethod = method;
  networkGrid.querySelectorAll('.network-chip').forEach((el) => {
    el.classList.remove('is-selected');
    el.setAttribute('aria-checked', 'false');
  });
  chipEl.classList.add('is-selected');
  chipEl.setAttribute('aria-checked', 'true');
}

function updatePhoneHint(country) {
  const rule = country && country.phoneRule;
  if (rule) {
    phoneHint.textContent = `${rule.digits} chiffres attendus pour ${country.country}, ex : ${rule.example}.`;
  } else {
    phoneHint.textContent = 'Format local, sans indicatif pays.';
  }
}

countrySelect.addEventListener('change', () => {
  selectedCountry = countriesData.find((c) => c.code === countrySelect.value) || null;
  renderNetworkChips(selectedCountry);
  updatePhoneHint(selectedCountry);
  currencyTag.textContent = selectedCountry ? `(${selectedCountry.currency})` : '';
});

// --- Suivi du transfert --------------------------------------------------

function showStatusPanel() {
  panelForm.classList.add('is-hidden');
  panelStatus.classList.remove('is-hidden');
}

// Un transfert passe par les étapes suivantes (voir server.js) :
//   payin_pending  -> l'expéditeur est en train de payer (ou vient de revenir)
//   payin_failed   -> paiement de l'expéditeur refusé/annulé (fin, échec)
//   payout_pending -> paiement reçu, envoi au destinataire en cours
//   completed      -> destinataire crédité (fin, succès)
//   payout_failed  -> paiement reçu MAIS envoi au destinataire échoué (fin, échec — cas à surveiller)
const STAGE_LABELS = {
  payin_pending: { title: 'En attente du paiement…', spinning: true },
  payout_pending: { title: 'Envoi au destinataire…', spinning: true },
  completed: { title: 'Transfert réussi', success: true },
  payin_failed: { title: 'Paiement refusé', success: false },
  payout_failed: { title: "Échec de l'envoi", success: false },
};

function renderPending(stage, message) {
  statusRing.className = 'status__ring is-spinning';
  statusIcon.textContent = '↻';
  statusTitle.textContent = (STAGE_LABELS[stage] && STAGE_LABELS[stage].title) || 'Transfert en cours…';
  statusMessage.textContent = message || 'Nous attendons la confirmation de FusionMoney. Cela ne prend généralement que quelques instants.';
  setStep('pending');
  newTransferBtn.classList.add('is-hidden');
}

function renderResult(stage, message) {
  const isSuccess = stage === 'completed';
  statusRing.className = `status__ring ${isSuccess ? 'is-success' : 'is-failed'}`;
  statusIcon.textContent = isSuccess ? '✓' : '✕';
  statusTitle.textContent = (STAGE_LABELS[stage] && STAGE_LABELS[stage].title) || (isSuccess ? 'Transfert réussi' : 'Transfert échoué');
  statusMessage.textContent = message;
  setStep('done', isSuccess ? 'success' : 'failed');
  newTransferBtn.classList.remove('is-hidden');
}

const FINAL_STAGES = ['completed', 'payin_failed', 'payout_failed'];

async function pollTransfer(transferId, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`/api/transfer/${encodeURIComponent(transferId)}`);
    const data = await response.json();

    if (data.success) {
      const { stage, message, recipient } = data.transfer;
      if (recipient) {
        summaryNetwork.textContent = `${recipient.networkName} — ${recipient.countryName}`;
        summaryAmount.textContent = `${recipient.amount} ${recipient.currency}`.trim();
        summaryPhone.textContent = recipient.phone;
      }

      // Une fois confirmé "completed" par le serveur (donc par le webhook
      // payout de FusionMoney), on quitte cette page pour la vraie page de
      // confirmation : /success.html.
      if (stage === 'completed') {
        window.location.href = `/success.html?transferId=${encodeURIComponent(transferId)}`;
        return stage;
      }

      if (FINAL_STAGES.includes(stage)) {
        renderResult(stage, message);
        return stage;
      }
      renderPending(stage, message);
    }
    await sleep(intervalMs);
  }

  renderResult('timeout', 'Délai dépassé. Le transfert peut tout de même aboutir : vérifiez plus tard.');
  return 'timeout';
}

// --- Soumission du formulaire --------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  const senderName = senderNameInput.value.trim();
  const senderPhone = senderPhoneInput.value.trim();
  const phone = phoneInput.value.trim();
  const digitsOnly = phone.replace(/\D/g, '');
  const amount = amountInput.value.trim();

  if (!senderName) {
    formError.textContent = 'Veuillez saisir votre nom.';
    return;
  }
  if (!senderPhone || senderPhone.replace(/\D/g, '').length < 6) {
    formError.textContent = 'Veuillez saisir votre numéro Mobile Money.';
    return;
  }
  if (!selectedCountry) {
    formError.textContent = 'Veuillez choisir un pays.';
    return;
  }
  if (!selectedMethod) {
    formError.textContent = 'Veuillez choisir un réseau.';
    return;
  }
  if (!phone) {
    formError.textContent = 'Veuillez saisir le numéro du destinataire.';
    return;
  }

  const rule = selectedCountry.phoneRule;
  if (rule && digitsOnly.length !== rule.digits) {
    formError.textContent = `Numéro invalide : ${rule.digits} chiffres attendus pour ${selectedCountry.country} (ex : ${rule.example}).`;
    return;
  }
  if (!rule && (digitsOnly.length < 6 || digitsOnly.length > 12)) {
    formError.textContent = 'Veuillez saisir un numéro de téléphone valide.';
    return;
  }

  if (!amount || Number(amount) <= 0) {
    formError.textContent = 'Veuillez saisir un montant valide.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.querySelector('.btn__label').textContent = 'Préparation du paiement…';

  try {
    const response = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderName,
        senderPhone: senderPhone.replace(/\D/g, ''),
        countryCode: selectedCountry.code,
        withdrawMode: selectedMethod.key,
        phone: digitsOnly,
        amount,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      formError.textContent = data.message || 'La création du transfert a échoué.';
      return;
    }

    // On redirige l'expéditeur vers la page de paiement FusionMoney : il y
    // valide le débit avec son propre Mobile Money. FusionMoney le renverra
    // ensuite vers cette même page (?transferId=...) pour reprendre le suivi.
    window.location.href = data.paymentUrl;
  } catch (err) {
    formError.textContent = 'Erreur réseau. Veuillez réessayer.';
    submitBtn.disabled = false;
    submitBtn.querySelector('.btn__label').textContent = 'Payer et envoyer';
  }
});

newTransferBtn.addEventListener('click', () => {
  form.reset();
  selectedCountry = null;
  selectedMethod = null;
  renderNetworkChips(null);
  updatePhoneHint(null);
  currencyTag.textContent = '';
  panelStatus.classList.add('is-hidden');
  panelForm.classList.remove('is-hidden');
  setStep('form');
});

// --- Reprise du suivi au retour de la page de paiement FusionMoney ------
// FusionMoney redirige l'expéditeur vers return_url=/?transferId=xxx une
// fois le paiement effectué : on détecte ce paramètre pour afficher
// directement le panneau de suivi (payin -> payout) au lieu du formulaire.

function resumeTransferFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const transferId = params.get('transferId');
  if (!transferId) return false;

  showStatusPanel();
  summaryToken.textContent = transferId;
  renderPending('payin_pending', 'Vérification du paiement…');
  pollTransfer(transferId);

  // Nettoie l'URL pour éviter de relancer le suivi lors d'un rechargement.
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

resumeTransferFromUrl();
loadMethods();
