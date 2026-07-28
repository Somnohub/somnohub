const nodemailer = require('nodemailer');

let transporter = null;

// Configuration SMTP via variables d'environnement :
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
// Tant qu'elles ne sont pas renseignées, les emails sont seulement simulés
// (affichés dans les logs) — même principe que le service SMS.
function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (host && user && pass) {
    const port = parseInt(process.env.EMAIL_PORT, 10) || 587;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = SSL ; 587 = STARTTLS
      auth: { user, pass },
    });
  }
  return transporter;
}

function emailConfigure() {
  return !!(getTransporter() && (process.env.EMAIL_FROM || process.env.EMAIL_USER));
}

// Adresse de l'admin destinataire des notifications internes
function adminEmail() {
  return process.env.ADMIN_EMAIL || 'admin@somnohub.fr';
}

async function envoyerEmail(to, sujet, texte, html) {
  const t = getTransporter();
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  if (!t || !from) {
    console.log(`[EMAIL SIMULÉ → ${to}] ${sujet}`);
    return { simule: true };
  }

  try {
    const info = await t.sendMail({ from, to, subject: sujet, text: texte, html: html || undefined });
    console.log(`[EMAIL] Envoyé à ${to} : ${sujet}`);
    return { id: info.messageId };
  } catch (e) {
    console.error('[EMAIL] Erreur envoi :', e.message);
    throw e;
  }
}

// Notification interne : nouvelle demande reçue
async function emailNouvelleDemande(demande) {
  const src = demande.source === 'medecin' ? 'Parcours médecin' : 'Parcours patient';
  const sujet = `Nouvelle demande de polygraphie #${demande.id} — ${demande.patient_prenom} ${demande.patient_nom}`;
  const lignes = [
    `Une nouvelle demande vient d'être reçue via ${src}.`,
    ``,
    `Patient : ${demande.patient_prenom} ${demande.patient_nom}`,
    `Téléphone : ${demande.telephone}`,
    demande.email ? `Email : ${demande.email}` : null,
    `Adresse : ${demande.adresse}`,
    demande.medecin_nom ? `Prescripteur : ${demande.medecin_nom}` : null,
    demande.indication ? `Indication : ${demande.indication}` : null,
    ``,
    `Traitez cette demande dans le cockpit admin : https://somnohub.fr/admin`,
  ].filter(Boolean);
  return envoyerEmail(adminEmail(), sujet, lignes.join('\n'));
}

// Notification patient : sa demande a été validée
async function emailDemandeValidee(demande) {
  const sujet = 'Votre demande de polygraphie a été validée — SomnoHub';
  const texte = [
    `Bonjour ${demande.patient_prenom},`,
    ``,
    `Bonne nouvelle : votre demande d'examen de polygraphie ventilatoire a été validée par notre équipe.`,
    ``,
    `Nous organisons désormais l'acheminement du boîtier à l'adresse indiquée. Vous serez recontacté(e) pour la suite.`,
    ``,
    `Si vous avez une ordonnance à nous transmettre et ne l'avez pas encore fait, vous pouvez répondre à cet email.`,
    ``,
    `L'équipe SomnoHub`,
  ].join('\n');
  return envoyerEmail(demande.email, sujet, texte);
}

module.exports = { envoyerEmail, emailConfigure, emailNouvelleDemande, emailDemandeValidee, adminEmail };
