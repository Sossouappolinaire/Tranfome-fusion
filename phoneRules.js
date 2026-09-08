// phoneRules.js
// Longueur attendue des numéros locaux (sans indicatif pays) pour les pays
// pris en charge par MoneyFusion. Ces plans de numérotation évoluent
// régulièrement (ex : le Bénin est passé de 8 à 10 chiffres le
// 30/11/2024, le Gabon de 8 à 9 chiffres le 06/04/2024) — seuls les pays
// listés ci-dessous ont une règle stricte, volontairement limitée à ceux
// dont le format a pu être vérifié auprès de sources fiables (régulateurs
// télécoms, presse spécialisée). Pour tout pays absent de cette table
// (renvoyé dynamiquement par FusionMoney mais non encore documenté ici),
// une validation générique et non bloquante est appliquée côté front-end
// (voir public/app.js) — le transfert reste possible, seul l'indice de
// format précis n'est pas affiché.
//
// ⚠️ À vérifier périodiquement : ces plans de numérotation changent.

const PHONE_RULES = {
  ci: { digits: 10, example: '0102030405' }, // Côte d'Ivoire — 10 chiffres depuis 2021
  bj: { digits: 10, example: '0197123456' }, // Bénin — 10 chiffres depuis le 30/11/2024
  tg: { digits: 8, example: '90123456' },    // Togo
  bf: { digits: 8, example: '70123456' },    // Burkina Faso
  sn: { digits: 9, example: '771234567' },   // Sénégal
  ne: { digits: 8, example: '90123456' },    // Niger
  cm: { digits: 9, example: '671234567' },   // Cameroun
  ga: { digits: 9, example: '074123456' },   // Gabon — 9 chiffres depuis le 06/04/2024
  ml: { digits: 8, example: '70123456' },    // Mali
};

function getPhoneRule(countryCode) {
  return PHONE_RULES[String(countryCode).toLowerCase()] || null;
}

module.exports = { PHONE_RULES, getPhoneRule };
