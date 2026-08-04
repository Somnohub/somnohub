const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { emailNouvelleDemande } = require('../services/email');

// Réception d'une demande de polygraphie — PUBLIC, sans authentification.
// Deux parcours : 'medecin' (avec RPPS + indication) ou 'patient' (grand public).
router.post('/', (req, res) => {
  try {
    const {
      source, patient_nom, patient_prenom, date_naissance,
      telephone, email, adresse, complement, code_postal, medecin_nom, medecin_rpps, indication,
      ordonnance_mode, consentement, lat, lng, couverture, mutuelle_nom,
      ordonnance_confirmee, avis_sommeil
    } = req.body;

    if (!['medecin', 'patient'].includes(source)) {
      return res.status(400).json({ error: 'Parcours invalide' });
    }
    if (!patient_nom || !patient_prenom || !telephone || !adresse) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }
    if (!medecin_nom || !String(medecin_nom).trim()) {
      return res.status(400).json({ error: 'Le nom du médecin prescripteur est obligatoire' });
    }
    // Déclarations du prescripteur : obligatoires et conservées (portée médico-légale)
    if (source === 'medecin') {
      if (!ordonnance_confirmee) {
        return res.status(400).json({ error: 'La confirmation de remise de l\'ordonnance est obligatoire' });
      }
      if (!avis_sommeil) {
        return res.status(400).json({ error: 'La demande d\'avis auprès d\'un médecin du sommeil est obligatoire' });
      }
    }
    if (!consentement) {
      return res.status(400).json({ error: 'Le consentement est obligatoire' });
    }

    const telClean = String(telephone).replace(/\s/g, '');
    if (!/^0[1-9]\d{8}$/.test(telClean)) {
      return res.status(400).json({ error: 'Numéro de téléphone invalide — 10 chiffres requis (ex: 0612345678)' });
    }

    // Email facultatif, mais validé si fourni
    const emailClean = (email || '').trim().toLowerCase();
    if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    // Adresse obligatoirement géolocalisée (choisie dans la liste Google)
    const latNum = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const lngNum = (typeof lng === 'number' && isFinite(lng)) ? lng : null;
    if (latNum === null || lngNum === null) {
      return res.status(400).json({ error: 'Merci de sélectionner votre adresse dans la liste proposée.' });
    }

    const mode = ordonnance_mode === 'transmise' ? 'transmise' : 'a_la_livraison';
    const couvertures = ['secu_seule', 'secu_mutuelle', 'css', 'ame', 'inconnu'];
    const couv = couvertures.includes(couverture) ? couverture : null;
    const cp = (code_postal || '').trim().replace(/\D/g, '').slice(0, 5) || null;

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO demandes (
        source, patient_nom, patient_prenom, date_naissance, telephone, email, adresse, complement, code_postal,
        medecin_nom, medecin_rpps, indication, couverture, mutuelle_nom, lat, lng, ordonnance_mode,
        ordonnance_confirmee, avis_sommeil, consentement, statut
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'recue')
    `).run(
      source,
      patient_nom.trim(), patient_prenom.trim(), (date_naissance || '').trim() || null,
      telClean, emailClean || null, adresse.trim(), (complement || '').trim() || null, cp,
      (medecin_nom || '').trim() || null, (medecin_rpps || '').trim() || null,
      (indication || '').trim() || null,
      couv, couv === 'secu_mutuelle' ? ((mutuelle_nom || '').trim() || null) : null,
      latNum, lngNum, mode,
      ordonnance_confirmee ? 1 : 0, avis_sommeil ? 1 : 0
    );

    const numero = result.lastInsertRowid;

    // Notification interne à l'admin (best-effort, ne bloque pas la réponse)
    const demande = db.prepare('SELECT * FROM demandes WHERE id = ?').get(numero);
    emailNouvelleDemande(demande).catch(e => console.error('[Demande] Notif admin échouée:', e.message));

    res.status(201).json({ success: true, numero });
  } catch (e) {
    console.error('[Demande] Erreur:', e);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de la demande' });
  }
});

module.exports = router;
