const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// Réception d'une demande de polygraphie — PUBLIC, sans authentification.
// Deux parcours : 'medecin' (avec RPPS + indication) ou 'patient' (grand public).
router.post('/', (req, res) => {
  try {
    const {
      source, patient_nom, patient_prenom, date_naissance,
      telephone, adresse, medecin_nom, medecin_rpps, indication,
      ordonnance_mode, consentement, lat, lng
    } = req.body;

    if (!['medecin', 'patient'].includes(source)) {
      return res.status(400).json({ error: 'Parcours invalide' });
    }
    if (!patient_nom || !patient_prenom || !telephone || !adresse) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }
    if (!consentement) {
      return res.status(400).json({ error: 'Le consentement est obligatoire' });
    }

    const telClean = String(telephone).replace(/\s/g, '');
    if (!/^0[1-9]\d{8}$/.test(telClean)) {
      return res.status(400).json({ error: 'Numéro de téléphone invalide — 10 chiffres requis (ex: 0612345678)' });
    }

    const mode = ordonnance_mode === 'transmise' ? 'transmise' : 'a_la_livraison';

    const db = getDb();
    const latNum = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const lngNum = (typeof lng === 'number' && isFinite(lng)) ? lng : null;

    const result = db.prepare(`
      INSERT INTO demandes (
        source, patient_nom, patient_prenom, date_naissance, telephone, adresse,
        medecin_nom, medecin_rpps, indication, lat, lng, ordonnance_mode, consentement, statut
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'recue')
    `).run(
      source,
      patient_nom.trim(), patient_prenom.trim(), (date_naissance || '').trim() || null,
      telClean, adresse.trim(),
      (medecin_nom || '').trim() || null, (medecin_rpps || '').trim() || null,
      (indication || '').trim() || null, latNum, lngNum, mode
    );

    res.status(201).json({ success: true, numero: result.lastInsertRowid });
  } catch (e) {
    console.error('[Demande] Erreur:', e);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de la demande' });
  }
});

module.exports = router;
