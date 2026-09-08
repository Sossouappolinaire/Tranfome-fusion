# Kouamé Paiement — Réseau vers autre

Application Node.js/Express qui permet un **vrai transfert réseau → réseau** :
on encaisse l'argent chez l'expéditeur (PAYIN), puis on l'envoie
automatiquement au destinataire (PAYOUT), dans **tous les pays pris en
charge par FusionMoney (MoneyFusion)**.

La liste des pays et réseaux disponibles pour le destinataire est récupérée
**dynamiquement** depuis `GET /withdraw/methods` : aucune liste codée en dur.

## Fonctionnement (PAYIN → webhook → PAYOUT)

1. Le front-end charge `/api/methods` (proxy vers FusionMoney) pour peupler
   les listes déroulantes Pays → Réseau du **destinataire**.
2. `POST /api/transfer` valide les données puis appelle l'API **Payin** de
   FusionMoney (`FUSIONMONEY_PAYIN_URL`) pour encaisser l'**expéditeur**.
   FusionMoney renvoie une `paymentUrl` : le front-end y redirige
   l'expéditeur pour qu'il valide le débit avec son propre Mobile Money.
3. FusionMoney renvoie l'expéditeur sur `return_url`
   (`/?transferId=...`) et notifie en parallèle
   `POST /api/webhook/payin` (`payin.session.completed` /
   `.cancelled` / `.pending`).
4. Dès que `payin.session.completed` est reçu, le serveur déclenche
   automatiquement le **Payout** (`POST /withdraw`) vers le destinataire —
   clé API privée jamais exposée au navigateur.
5. FusionMoney notifie l'issue finale via `POST /api/webhook/payout`
   (`payout.session.completed` / `.cancelled`).
6. Au retour sur `/?transferId=...`, le front-end (`index.html`) interroge
   `GET /api/transfer/:transferId` toutes les 3 s jusqu'à un statut final :
   - `completed` — le destinataire a bien été crédité. Le front-end
     redirige alors vers **`success.html?transferId=...`**, une page dédiée
     qui revérifie l'état auprès du serveur avant d'afficher la
     confirmation (impossible d'y accéder directement pour un transfert non
     terminé — elle renvoie vers `index.html` dans ce cas) ;
   - `payin_failed` — l'expéditeur n'a pas payé (rien n'a été prélevé),
     affiché directement sur `index.html` ;
   - `payout_failed` — **cas à surveiller** : l'expéditeur a payé mais
     l'envoi au destinataire a échoué (réseau indisponible, solde marchand
     insuffisant…), affiché sur `index.html`. FusionMoney ne rembourse ni
     ne relance
     automatiquement : prévoyez un remboursement, une nouvelle tentative ou
     un suivi manuel pour ce cas.

⚠️ Le stockage des transferts en cours est fait en mémoire (`Map`) : il est
perdu à chaque redémarrage du service. Pour de la production, remplacez-le
par une vraie base de données — c'est d'autant plus important que c'est ce
qui relie le webhook payin au payout à déclencher.

## Réseaux et validation des numéros

- Les **pays et réseaux** affichés dans le formulaire sont récupérés en
  direct depuis FusionMoney (`GET /withdraw/methods`) — tout pays ajouté
  côté FusionMoney apparaît automatiquement, sans modification du code.
- Chaque réseau (MTN, Orange, Moov, Wave…) est représenté par un **badge
  coloré généré côté client** (pas les logos officiels des marques, pour
  des raisons de droits d'usage).
- Le **nombre de chiffres attendu par numéro** est vérifié (côté
  formulaire **et** côté serveur, dans `phoneRules.js`) pour les pays dont
  le plan de numérotation a pu être confirmé auprès de sources fiables
  (Côte d'Ivoire, Bénin, Togo, Burkina Faso, Sénégal, Niger, Cameroun,
  Gabon, Mali). Pour tout autre pays renvoyé par FusionMoney, une
  validation générique (6 à 12 chiffres) s'applique — le transfert reste
  possible.
- ⚠️ Les plans de numérotation changent (le Bénin est passé à 10 chiffres
  le 30/11/2024, le Gabon à 9 chiffres le 06/04/2024) : vérifiez et mettez
  à jour `phoneRules.js` périodiquement.

## Prérequis côté dashboard MoneyFusion

Avant de faire une requête de retrait (voir doc officielle, section
Paramètres) :

1. **Récupérez l'URL de votre API Payin** (section API Web du dashboard) et
   renseignez-la dans `FUSIONMONEY_PAYIN_URL` — sans elle, l'encaissement de
   l'expéditeur échouera.
2. **Générez une clé API privée** depuis votre tableau de bord MoneyFusion
   (sert au payout).
3. **Ajoutez l'adresse IP fixe de votre serveur** dans le dashboard — sans
   cela, les retraits (payout) seront rejetés. Si votre hébergeur ne
   fournit pas d'IP fixe (certaines offres gratuites de Render, Vercel,
   Cloudflare…), utilisez un serveur dédié / VPS dont vous contrôlez l'IP,
   ou une offre payante avec IP statique.

## Déploiement sur Render.com

1. Poussez ce dossier sur un dépôt GitHub/GitLab.
2. Sur Render : **New +** → **Web Service** → connectez le dépôt.
3. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
4. Dans l'onglet **Environment**, ajoutez les variables :
   | Clé | Valeur |
   |---|---|
   | `FUSIONMONEY_PRIVATE_KEY` | votre clé privée (dashboard MoneyFusion) |
   | `FUSIONMONEY_PAYIN_URL` | l'URL de votre API Payin (dashboard MoneyFusion > API Web) |
   | `FUSIONMONEY_BASE_URL` | `https://pay.moneyfusion.net/api/v1` |

   Inutile d'ajouter `PUBLIC_BASE_URL` ou `WEBHOOK_SECRET` : Render fournit
   automatiquement `RENDER_EXTERNAL_URL` (utilisée comme URL publique), et
   l'app génère elle-même un secret webhook au démarrage si vous n'en
   fournissez pas un. N'ajoutez ces deux variables que si vous voulez
   forcer une valeur précise (domaine personnalisé, secret stable entre
   redémarrages).
5. Déployez. Render assigne automatiquement `PORT` (le service écoute
   dessus, avec `10000` comme valeur de repli si non fournie).
6. Notez l'IP sortante fixe de votre service Render (offre payante requise
   pour une IP statique) et ajoutez-la dans le dashboard MoneyFusion.

## Vérifier que les variables d'environnement sont bien chargées

Après le déploiement (ou un redéploiement), deux façons de confirmer que
Render a bien pris en compte vos variables :

1. **Logs Render** — onglet **Logs** du service : juste après
   `Serveur lancé sur le port ...`, un résumé s'affiche automatiquement
   (✅/❌ pour chaque variable, sans jamais afficher sa valeur) :
   ```
   --- Vérification des variables d'environnement ---
   ✅ FUSIONMONEY_PRIVATE_KEY (requise) — chargée — ...
   ❌ FUSIONMONEY_PAYIN_URL (requise) — absente — ...
   ...
   ```
2. **Route `/api/health`** — ouvrez
   `https://votre-service.onrender.com/api/health` dans le navigateur :
   renvoie un JSON `{ "ok": true/false, "missingRequired": [...], "vars": [...] }`.
   `ok: false` = au moins une variable requise manque → allez dans
   **Environment** sur Render, ajoutez-la, puis redéployez (**Manual
   Deploy** → **Deploy latest commit**).

## Test en local

```bash
cp .env.example .env
# renseignez vos clés dans .env
npm install
npm start
# -> http://localhost:10000
```

## Domaine personnalisé (optionnel)

Si vous utilisez en parallèle une boutique MoneyFusion (hors de cette
application), vous pouvez y connecter un domaine personnalisé en ajoutant,
chez votre registrar, un enregistrement `A` (`@` → `135.181.19.210`) et un
`CNAME` (`www` → `moneyfusion.net`), puis en le renseignant dans votre
espace MoneyFusion.

## Structure du projet

```
fusionpay-transfert/
├── server.js              # routes Express + orchestration payin -> webhook -> payout
├── fusionMoneyService.js  # appels aux API Payin ET Payout de FusionMoney
├── config.js               # variables d'environnement
├── public/
│   ├── index.html          # formulaire + suivi payin/payout en direct
│   ├── success.html        # page de confirmation finale (après redirection)
│   ├── success.js          # revérifie l'état auprès du serveur avant d'afficher le succès
│   ├── style.css
│   └── app.js
├── package.json
└── .env.example
```
