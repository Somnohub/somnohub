const nodemailer = require('nodemailer');

let transporter = null;

// ─── Deux modes d'envoi ─────────────────────────────────────────────────────
// 1. API HTTPS (recommandé) : BREVO_API_KEY — passe par le port 443.
//    Indispensable car les hébergeurs cloud (dont Railway) bloquent
//    fréquemment les ports SMTP sortants : la connexion reste alors
//    suspendue indéfiniment sans jamais aboutir.
// 2. SMTP (repli) : EMAIL_HOST / EMAIL_PORT / EMAIL_USER / EMAIL_PASS
// Sans configuration, les emails sont seulement simulés dans les logs.

function apiKeyBrevo() {
  return process.env.BREVO_API_KEY || null;
}

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
      // Délais courts : si le port est bloqué, on échoue vite avec une erreur
      // claire plutôt que de laisser la requête suspendue.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

function emailConfigure() {
  if (apiKeyBrevo()) return true;
  return !!(getTransporter() && (process.env.EMAIL_FROM || process.env.EMAIL_USER));
}

// Mode d'envoi actif, pour l'affichage dans l'espace admin
function emailMode() {
  if (apiKeyBrevo()) return 'api';
  if (getTransporter() && (process.env.EMAIL_FROM || process.env.EMAIL_USER)) return 'smtp';
  return 'simule';
}

// Découpe "SomnoHub <no-reply@somnohub.fr>" en { name, email }
function parseFrom(from) {
  const m = String(from || '').match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1] || 'SomnoHub', email: m[2] };
  return { name: 'SomnoHub', email: String(from || '').trim() };
}

// Envoi via l'API HTTPS de Brevo (port 443, non bloqué)
async function envoyerViaApi(to, sujet, texte) {
  const from = parseFrom(process.env.EMAIL_FROM || process.env.EMAIL_USER);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKeyBrevo(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: from.name, email: from.email },
      to: [{ email: to }],
      subject: sujet,
      textContent: texte,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const corps = await res.text().catch(() => '');
    throw new Error(`API email ${res.status} : ${corps.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { id: data.messageId };
}

// Adresse de l'admin destinataire des notifications internes
function adminEmail() {
  return process.env.ADMIN_EMAIL || 'admin@somnohub.fr';
}

async function envoyerEmail(to, sujet, texte, html) {
  if (!to) throw new Error('Destinataire manquant');

  // 1. API HTTPS en priorité (fonctionne même si les ports SMTP sont bloqués)
  if (apiKeyBrevo()) {
    try {
      const r = await envoyerViaApi(to, sujet, texte);
      console.log(`[EMAIL] Envoyé (API) à ${to} : ${sujet}`);
      return r;
    } catch (e) {
      console.error('[EMAIL] Erreur envoi (API) :', e.message);
      throw e;
    }
  }

  // 2. Repli SMTP
  const t = getTransporter();
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  if (!t || !from) {
    console.log(`[EMAIL SIMULÉ → ${to}] ${sujet}`);
    return { simule: true };
  }

  try {
    const info = await t.sendMail({ from, to, subject: sujet, text: texte, html: html || undefined });
    console.log(`[EMAIL] Envoyé (SMTP) à ${to} : ${sujet}`);
    return { id: info.messageId };
  } catch (e) {
    console.error('[EMAIL] Erreur envoi (SMTP) :', e.message);
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
    demande.complement ? `Complément : ${demande.complement}` : null,
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

module.exports = { envoyerEmail, emailConfigure, emailMode, emailNouvelleDemande, emailDemandeValidee, adminEmail };
