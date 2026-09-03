const { getDb } = require('../db');

let twilioClient = null;

// ── Brevo (voie principale) ──────────────────────────────────────────
// Les numéros français de Twilio ne portent pas le SMS : Brevo envoie sous un
// nom d'expéditeur alphanumérique, ce qui contourne la contrainte. Même compte
// et même clé que les emails, sur un port HTTPS que Railway ne bloque pas.
function cleBrevo() {
  return process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || '';
}

// Nom affiché à la place du numéro. 11 caractères maximum, lettres et chiffres.
function expediteurBrevo() {
  return (process.env.BREVO_SMS_SENDER || 'SomnoHub').slice(0, 11);
}

function brevoSmsConfigure() {
  return !!cleBrevo();
}

// Brevo attend le numéro sans le « + » : 33612345678
function toBrevo(tel) {
  return toE164(tel).replace(/^\+/, '');
}

async function envoyerViaBrevo(telephone, message) {
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'api-key': cleBrevo(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: expediteurBrevo(),
      recipient: toBrevo(telephone),
      content: message,
      type: 'transactional',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const corps = await res.text().catch(() => '');
    throw new Error(`API SMS ${res.status} : ${corps.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return data.messageId || data.reference || 'ok';
}


function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (sid && token && sid.startsWith('AC')) {
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
  }
  return twilioClient;
}

// Vrai si Twilio est complètement configuré (SID + token + numéro expéditeur)
function twilioConfigure() {
  return !!(getTwilioClient() && process.env.TWILIO_PHONE_NUMBER);
}

// Un canal, quel qu'il soit, est-il disponible ?
function smsConfigure() {
  return brevoSmsConfigure() || twilioConfigure();
}

function smsMode() {
  if (brevoSmsConfigure()) return `Brevo (expéditeur « ${expediteurBrevo()} »)`;
  if (twilioConfigure()) return 'Twilio';
  return 'aucun — les SMS sont simulés';
}

// Normalise un numéro français au format international E.164 (+33…)
function toE164(tel) {
  const s = String(tel || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('0033')) return '+' + s.slice(2);
  if (s.startsWith('33')) return '+' + s;
  if (s.startsWith('0')) return '+33' + s.slice(1);
  return '+33' + s;
}

// Envoi de test (sans lien patient) — utilisé pour vérifier la config
async function envoyerSMSTest(to, message) {
  if (brevoSmsConfigure()) return envoyerViaBrevo(to, message);

  const client = getTwilioClient();
  if (!client || !process.env.TWILIO_PHONE_NUMBER) {
    throw new Error('Aucun canal SMS configuré (BREVO_API_KEY, ou TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)');
  }
  const res = await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: toE164(to),
  });
  return res.sid;
}

async function envoyerSMS(patientId, type, message, telephone) {
  const db = getDb();
  const trace = (statut) =>
    db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, ?)`)
      .run(patientId, type, message, statut);

  if (brevoSmsConfigure()) {
    try {
      await envoyerViaBrevo(telephone, message);
      trace('envoye');
      console.log(`[SMS] Envoyé (Brevo) à ${telephone} : ${message.substring(0, 50)}…`);
    } catch (err) {
      console.error('[SMS] Erreur Brevo :', err.message);
      trace('erreur');
    }
    return;
  }

  const client = getTwilioClient();

  if (client && process.env.TWILIO_PHONE_NUMBER) {
    try {
      await client.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: toE164(telephone),
      });
      db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'envoye')`).run(patientId, type, message);
      console.log(`[SMS] Envoyé à ${telephone}: ${message.substring(0, 50)}...`);
    } catch (err) {
      console.error('[SMS] Erreur Twilio:', err.message);
      db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'erreur')`).run(patientId, type, message);
    }
  } else {
    db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'simule')`).run(patientId, type, message);
    console.log(`[SMS SIMULÉ → ${telephone}] ${message}`);
  }
}

async function smsPrescription(patient) {
  const msg = `Bonjour ${patient.prenom}, votre médecin a prescrit une polygraphie du sommeil. Notre livreur passera ce soir entre 17h et 19h. Merci d'être disponible.`;
  await envoyerSMS(patient.id, 'prescription', msg, patient.telephone);
}

async function smsRappelRecuperation(patient) {
  const msg = `Bonjour ${patient.prenom}, notre livreur passera ce matin entre 7h et 9h récupérer votre boîtier de polygraphie. Merci de le préparer.`;
  await envoyerSMS(patient.id, 'rappel_recuperation', msg, patient.telephone);
}

async function smsSuivi3Mois(patient, medecin) {
  const msg = `Bonjour ${patient.prenom}, votre suivi sommeil à 3 mois approche. Contactez le Dr ${medecin.nom} pour programmer votre consultation de suivi.`;
  await envoyerSMS(patient.id, 'suivi_3mois', msg, patient.telephone);
}

async function smsSuivi6Mois(patient, medecin) {
  const msg = `Bonjour ${patient.prenom}, votre suivi sommeil à 6 mois approche. Contactez le Dr ${medecin.nom} pour programmer votre consultation de suivi.`;
  await envoyerSMS(patient.id, 'suivi_6mois', msg, patient.telephone);
}

async function smsSuivi1An(patient, medecin) {
  const msg = `Bonjour ${patient.prenom}, votre suivi sommeil annuel approche. Contactez le Dr ${medecin.nom} pour programmer votre consultation de suivi.`;
  await envoyerSMS(patient.id, 'suivi_1an', msg, patient.telephone);
}

async function smsDepartTournee(patient) {
  const msg = `Bonjour ${patient.prenom}, votre boîtier de polygraphie du sommeil sera déposé dans votre boîte aux lettres ce soir. Scannez le QR code sur le boîtier pour accéder aux instructions et réalisez votre examen cette nuit. L'équipe SomnoHub.`;
  await envoyerSMS(patient.id, 'depart_tournee', msg, patient.telephone);
}

const DOCTOLIB_PARTENAIRE = 'https://www.doctolib.fr/medecin-generaliste/eragny/yassine-oumamar-eragny';

// Rédigé sans accent circonflexe ni tréma : hors du jeu GSM-7, un seul de ces
// caractères ferait basculer le SMS en UCS-2, soit 70 caractères par segment
// au lieu de 160 — et donc un segment facturé de plus.
async function smsResultatsDisponibles(patient) {
  const msg = `Bonjour ${patient.prenom}, les résultats de votre polygraphie ventilatoire (test du sommeil) sont disponibles. `
    + `Ils vous seront remis uniquement lors d'une consultation ou téléconsultation. `
    + `Prenez RDV : ${DOCTOLIB_PARTENAIRE}`;
  await envoyerSMS(patient.id, 'resultats_disponibles', msg, patient.telephone);
}

module.exports = { smsResultatsDisponibles, smsConfigure, smsMode, smsPrescription, smsRappelRecuperation, smsSuivi3Mois, smsSuivi6Mois, smsSuivi1An, smsDepartTournee, envoyerSMSTest, twilioConfigure, toE164 };
