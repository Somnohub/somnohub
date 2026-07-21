const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const auth = require('../middleware/auth');
const { genererAlertes } = require('../services/scheduler');

// Scanner un boîtier après nettoyage et upload
router.post('/scan', auth(['assistante', 'admin']), async (req, res) => {
  const { boitier_numero } = req.body;

  if (!boitier_numero) {
    return res.status(400).json({ error: 'Numéro de boîtier requis' });
  }

  const db = getDb();
  const boitier = await db.prepare('SELECT * FROM boitiers WHERE numero = ?').get(boitier_numero);

  if (!boitier) {
    return res.status(404).json({ error: `Boîtier ${boitier_numero} introuvable` });
  }

  if (boitier.statut !== 'en_analyse') {
    return res.status(400).json({
      error: `Boîtier ${boitier_numero} n'est pas en cours d'analyse (statut actuel: ${boitier.statut})`,
      statut_actuel: boitier.statut
    });
  }

  // Remettre le boîtier disponible
  await db.prepare(`
    UPDATE boitiers SET statut = 'disponible', patient_id = NULL, derniere_action = CURRENT_TIMESTAMP WHERE id = ?
  `).run(boitier.id);

  // Le patient dont le boîtier est revenu → résultat disponible
  const dernierPatient = await db.prepare(`
    SELECT p.* FROM patients p
    WHERE p.statut = 'en_cours_d_analyse'
    AND p.id IN (
      SELECT patient_id FROM tournee_stops WHERE boitier_id = ?
      ORDER BY created_at DESC LIMIT 1
    )
  `).get(boitier.id);

  let patientMisAJour = null;
  if (dernierPatient) {
    await db.prepare(`UPDATE patients SET statut = 'resultat_disponible', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(dernierPatient.id);
    await db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'resultat_disponible', 'Données uploadées et analysées', ?)`).run(dernierPatient.id, req.user.id);

    // Enregistrer le revenu
    const tarif = parseFloat(process.env.TARIF_EXAMEN) || 150;
    const today = new Date().toISOString().split('T')[0];
    await db.prepare(`INSERT INTO revenus (medecin_id, patient_id, montant, date) VALUES (?, ?, ?, ?)`).run(dernierPatient.medecin_id, dernierPatient.id, tarif, today);

    patientMisAJour = { id: dernierPatient.id, nom: dernierPatient.nom, prenom: dernierPatient.prenom };
  }

  await genererAlertes();

  res.json({
    success: true,
    message: `✅ Boîtier ${boitier_numero} nettoyé et disponible`,
    boitier_numero,
    patient_mis_a_jour: patientMisAJour
  });
});

// Historique des scans du jour
router.get('/scans-aujourd-hui', auth(['assistante', 'admin']), async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const scans = await db.prepare(`
    SELECT b.numero, b.derniere_action,
      p.nom as patient_nom, p.prenom as patient_prenom
    FROM boitiers b
    LEFT JOIN patients p ON b.patient_id = p.id
    WHERE b.derniere_action::date = ?::date AND b.statut = 'disponible'
    ORDER BY b.derniere_action DESC
  `).all(today);

  res.json(scans);
});

// Stats du jour / mois / stock
router.get('/stats', auth(['assistante', 'admin']), async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const firstOfMonth = today.slice(0, 7) + '-01';

  const aujourd_hui = (await db.prepare(`
    SELECT COUNT(*) as nb FROM boitiers
    WHERE derniere_action::date = ?::date AND statut = 'disponible'
  `).get(today)).nb;

  const ce_mois = (await db.prepare(`
    SELECT COUNT(*) as nb FROM boitiers
    WHERE derniere_action::date >= ?::date AND statut = 'disponible'
  `).get(firstOfMonth)).nb;

  const disponibles = (await db.prepare(`
    SELECT COUNT(*) as nb FROM boitiers WHERE statut = 'disponible'
  `).get()).nb;

  res.json({ aujourd_hui, ce_mois, disponibles });
});

module.exports = router;
