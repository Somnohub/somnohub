const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { emailNouvelleDemande, emailDemandeRecue } = require('../services/email');
const express_raw = express.raw;
const ordo = require('../services/ordonnances');

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

    // Adresse : normalement géolocalisée via la liste Google. Si l'autocomplétion
    // est indisponible côté visiteur (bloqueur, extension, réseau restreint), on
    // accepte une saisie manuelle suffisamment détaillée, marquée « à vérifier ».
    const latNum = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const lngNum = (typeof lng === 'number' && isFinite(lng)) ? lng : null;
    const geolocalisee = latNum !== null && lngNum !== null;
    if (!geolocalisee && String(adresse).trim().length < 12) {
      return res.status(400).json({ error: 'Merci d\'indiquer votre adresse complète, avec le code postal et la ville.' });
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
        ordonnance_confirmee, avis_sommeil, adresse_verifiee, consentement, statut
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'recue')
    `).run(
      source,
      patient_nom.trim(), patient_prenom.trim(), (date_naissance || '').trim() || null,
      telClean, emailClean || null, adresse.trim(), (complement || '').trim() || null, cp,
      (medecin_nom || '').trim() || null, (medecin_rpps || '').trim() || null,
      (indication || '').trim() || null,
      couv, couv === 'secu_mutuelle' ? ((mutuelle_nom || '').trim() || null) : null,
      latNum, lngNum, mode,
      ordonnance_confirmee ? 1 : 0, avis_sommeil ? 1 : 0, geolocalisee ? 1 : 0
    );

    const numero = result.lastInsertRowid;

    // Jeton à usage unique autorisant l'envoi de l'ordonnance qui suit.
    // Sans lui, n'importe qui pourrait joindre un fichier à n'importe quelle demande.
    const jeton = ordo.nouveauJeton();
    db.prepare('UPDATE demandes SET ordonnance_token = ? WHERE id = ?').run(jeton, numero);

    // Notification interne à l'admin (best-effort, ne bloque pas la réponse)
    const demande = db.prepare('SELECT * FROM demandes WHERE id = ?').get(numero);
    emailNouvelleDemande(demande).catch(e => console.error('[Demande] Notif admin échouée:', e.message));
    // Accusé de réception au demandeur — sans lui, il n'a aucune trace écrite.
    emailDemandeRecue(demande).catch(e => console.error('[Demande] Accusé de réception échoué:', e.message));

    res.status(201).json({ success: true, numero, upload_token: jeton });
  } catch (e) {
    console.error('[Demande] Erreur:', e);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de la demande' });
  }
});

// Envoi de l'ordonnance, en deux temps : la demande est créée d'abord, le
// document suit. Le corps arrive en binaire brut — le parseur JSON global ne
// le touche pas, et la limite de taille reste cantonnée à cette route.
router.post('/:numero/ordonnance',
  express_raw({ type: 'application/octet-stream', limit: ordo.TAILLE_MAX + 1024 }),
  (req, res) => {
    try {
      const numero = parseInt(req.params.numero, 10);
      const jeton = req.get('X-Upload-Token') || '';
      if (!numero || !jeton) return res.status(400).json({ error: 'Requête incomplète' });

      const db = getDb();
      const d = db.prepare('SELECT id, ordonnance_token, ordonnance_fichier FROM demandes WHERE id = ?').get(numero);
      if (!d || !d.ordonnance_token || d.ordonnance_token !== jeton) {
        return res.status(403).json({ error: 'Envoi non autorisé' });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Fichier vide' });
      }

      const r = ordo.enregistrer(numero, req.body);
      if (r.erreur) return res.status(400).json({ error: r.erreur });

      // Un remplacement ne doit pas laisser l'ancien fichier derrière lui.
      if (d.ordonnance_fichier) ordo.supprimer(d.ordonnance_fichier);

      // Le jeton est consommé : un seul envoi par demande.
      db.prepare('UPDATE demandes SET ordonnance_fichier = ?, ordonnance_mime = ?, ordonnance_token = NULL WHERE id = ?')
        .run(r.nom, r.mime, numero);

      res.json({ success: true });
    } catch (e) {
      if (e.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Fichier trop volumineux — 5 Mo maximum.' });
      }
      console.error('[Ordonnance] Erreur:', e);
      res.status(500).json({ error: "Impossible d'enregistrer l'ordonnance" });
    }
  });

module.exports = router;
