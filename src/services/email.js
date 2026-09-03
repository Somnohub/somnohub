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
async function envoyerViaApi(to, sujet, texte, html) {
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
      ...(html ? { htmlContent: html } : {}),
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
      const r = await envoyerViaApi(to, sujet, texte, html);
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

// ── Gabarit commun ────────────────────────────────────────────────────
// Tableaux et styles en ligne : c'est la seule mise en forme que les clients
// de messagerie rendent de façon fiable (Outlook, Gmail, Apple Mail).
const DOCTOLIB_PARTENAIRE = 'https://www.doctolib.fr/medecin-generaliste/eragny/yassine-oumamar-eragny';

function ech(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function bouton(url, libelle, couleur = '#1a3d2b') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0">
    <tr><td style="background:${couleur};border-radius:8px">
      <a href="${url}" style="display:inline-block;padding:13px 26px;color:#ffffff;
        font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;
        text-decoration:none">${ech(libelle)}</a>
    </td></tr></table>`;
}

function gabarit(titre, corpsHtml) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ech(titre)}</title></head>
<body style="margin:0;padding:0;background:#f4f7f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f5;padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d4e0d9;border-radius:14px;overflow:hidden">
    <tr><td style="background:#1a3d2b;padding:20px 28px">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:bold;color:#ffffff">Somno</span><span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:bold;color:#52b788">Hub</span>
    </td></tr>
    <tr><td style="padding:28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#4a5e53">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1a3d2b">${ech(titre)}</h1>
      ${corpsHtml}
    </td></tr>
    <tr><td style="padding:18px 28px;background:#f4f7f5;border-top:1px solid #d4e0d9;
      font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:#7a9186">
      SomnoHub — dépistage de l'apnée du sommeil à domicile<br>
      <a href="https://somnohub.fr" style="color:#52b788;text-decoration:none">somnohub.fr</a>
      &nbsp;·&nbsp;
      <a href="mailto:admin@somnohub.fr" style="color:#52b788;text-decoration:none">admin@somnohub.fr</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function p(t) { return `<p style="margin:0 0 14px">${t}</p>`; }

// ── Accusé de réception au demandeur ──────────────────────────────────
async function emailDemandeRecue(demande) {
  if (!demande.email) return { ignore: 'pas d\'email' };
  const prenom = demande.patient_prenom || '';
  const sujet = `Nous avons bien reçu votre demande — SomnoHub`;

  const texte = [
    `Bonjour ${prenom},`,
    ``,
    `Nous avons bien reçu votre demande de polygraphie ventilatoire.`,
    `Numéro de dossier : #${demande.id}`,
    ``,
    `Un membre de notre équipe vous contactera dans les plus brefs délais pour vous expliquer les modalités de réalisation de l'examen.`,
    ``,
    `Vous n'avez rien à faire d'ici là. Conservez simplement votre ordonnance : elle est indispensable à la réalisation de l'examen.`,
    ``,
    `Une question ? Répondez simplement à cet email.`,
    ``,
    `L'équipe SomnoHub`,
  ].join('\n');

  const html = gabarit('Nous avons bien reçu votre demande', [
    p(`Bonjour <strong>${ech(prenom)}</strong>,`),
    p(`Votre demande de <strong>polygraphie ventilatoire</strong> nous est bien parvenue.`),
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f0faf4;border:1px solid #b7e4c7;border-radius:10px;margin:0 0 18px">
       <tr><td style="padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#4a5e53">
       Numéro de dossier <strong style="color:#1a3d2b;font-size:16px">#${ech(demande.id)}</strong></td></tr></table>`,
    p(`Un membre de notre équipe vous contactera <strong>dans les plus brefs délais</strong> pour vous expliquer les modalités de réalisation de l'examen.`),
    p(`Vous n'avez rien à faire d'ici là. Conservez simplement votre ordonnance : elle est indispensable à la réalisation de l'examen.`),
    p(`<span style="color:#7a9186;font-size:13px">Une question ? Répondez simplement à cet email.</span>`),
  ].join(''));

  return envoyerEmail(demande.email, sujet, texte, html);
}

// ── Examen réalisé, boîtier récupéré ──────────────────────────────────
async function emailExamenRealise(patient) {
  if (!patient || !patient.email) return { ignore: 'pas d\'email' };
  const sujet = 'Votre examen a bien été réalisé — SomnoHub';

  const texte = [
    `Bonjour ${patient.prenom || ''},`,
    ``,
    `Votre examen a bien été réalisé et nous avons récupéré le boîtier.`,
    ``,
    `L'enregistrement est maintenant analysé par un médecin. Le compte-rendu est établi sous 48 à 72 h.`,
    ``,
    `Vos résultats vous seront remis et expliqués par notre médecin partenaire, lors d'une consultation.`,
    `Prenez rendez-vous dès maintenant : ${DOCTOLIB_PARTENAIRE}`,
    ``,
    `Prendre le rendez-vous sans attendre vous évite de perdre du temps une fois le compte-rendu prêt.`,
    ``,
    `L'équipe SomnoHub`,
  ].join('\n');

  const html = gabarit('Votre examen a bien été réalisé', [
    p(`Bonjour <strong>${ech(patient.prenom || '')}</strong>,`),
    p(`Votre examen a bien été réalisé et nous avons <strong>récupéré le boîtier</strong>. Merci.`),
    p(`L'enregistrement est à présent analysé par un médecin. Le compte-rendu est établi <strong>sous 48 à 72 h</strong>.`),
    p(`Vos résultats vous seront <strong>remis et expliqués par notre médecin partenaire</strong>, au cours d'une consultation.`),
    bouton(DOCTOLIB_PARTENAIRE, 'Prendre rendez-vous sur Doctolib', '#0596DE'),
    p(`<span style="color:#7a9186;font-size:13px">Prendre le rendez-vous dès maintenant vous évite d'attendre une fois le compte-rendu prêt.</span>`),
  ].join(''));

  return envoyerEmail(patient.email, sujet, texte, html);
}

// ── Demande refusée ───────────────────────────────────────────────────
async function emailDemandeRefusee(demande) {
  if (!demande.email) return { ignore: 'pas d\'email' };
  const motif = (demande.motif_refus || '').trim();
  const sujet = 'Votre demande de polygraphie — SomnoHub';

  const texte = [
    `Bonjour ${demande.patient_prenom || ''},`,
    ``,
    `Nous ne sommes pas en mesure de donner suite à votre demande de polygraphie ventilatoire (dossier #${demande.id}).`,
    motif ? `` : null,
    motif ? `Motif : ${motif}` : null,
    ``,
    `Si vous pensez qu'il s'agit d'une erreur, ou si votre situation a changé, répondez à cet email : nous réexaminerons votre dossier.`,
    ``,
    `L'équipe SomnoHub`,
  ].filter(x => x !== null).join('\n');

  const html = gabarit('Votre demande de polygraphie', [
    p(`Bonjour <strong>${ech(demande.patient_prenom || '')}</strong>,`),
    p(`Nous ne sommes pas en mesure de donner suite à votre demande de polygraphie ventilatoire <strong>(dossier #${ech(demande.id)})</strong>.`),
    motif ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#fff8ee;border:1px solid #ffd9a0;border-radius:10px;margin:0 0 18px">
       <tr><td style="padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#4a5e53">
       <strong style="color:#b25e00">Motif</strong><br>${ech(motif)}</td></tr></table>` : '',
    p(`Si vous pensez qu'il s'agit d'une erreur, ou si votre situation a changé, répondez à cet email : nous réexaminerons votre dossier.`),
  ].join(''));

  return envoyerEmail(demande.email, sujet, texte, html);
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
  const html = gabarit('Votre demande a été validée', [
    p(`Bonjour <strong>${ech(demande.patient_prenom)}</strong>,`),
    p(`Bonne nouvelle : votre demande d'examen de <strong>polygraphie ventilatoire</strong> a été validée par notre équipe.`),
    p(`Nous organisons l'acheminement du boîtier à l'adresse que vous nous avez indiquée. Vous serez recontacté(e) pour convenir des modalités.`),
    p(`<span style="color:#7a9186;font-size:13px">Vous n'avez pas encore transmis votre ordonnance ? Répondez à cet email en la joignant.</span>`),
  ].join(''));
  return envoyerEmail(demande.email, sujet, texte, html);
}

module.exports = { envoyerEmail, emailConfigure, emailMode, emailNouvelleDemande,
  emailDemandeValidee, emailDemandeRecue, emailExamenRealise, emailDemandeRefusee, adminEmail };
