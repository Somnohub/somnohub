const { getDb } = require('../db');

let twilioClient = null;

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
  const client = getTwilioClient();
  if (!client || !process.env.TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER manquants)');
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
  const client = getTwilioClient();

  if (client && process.env.TWILIO_PHONE_NUMBER) {
    try {
      await client.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: toE164(telephone),
      });
      await db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'envoye')`).run(patientId, type, message);
      console.log(`[SMS] Envoyé à ${telephone}: ${message.substring(0, 50)}...`);
    } catch (err) {
      console.error('[SMS] Erreur Twilio:', err.message);
      await db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'erreur')`).run(patientId, type, message);
    }
  } else {
    await db.prepare(`INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, 'simule')`).run(patientId, type, message);
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

module.exports = { smsPrescription, smsRappelRecuperation, smsSuivi3Mois, smsSuivi6Mois, smsSuivi1An, smsDepartTournee, envoyerSMSTest, twilioConfigure, toE164 };
