/* SomnoHub — Google Ads (gtag) + consentement CNIL
 * ---------------------------------------------------------------
 * Le tag publicitaire dépose des cookies : il ne démarre qu'après
 * un consentement explicite (Consent Mode v2, refus par défaut).
 * Umami reste actif en permanence : sans cookie, il ne requiert pas
 * de consentement.
 * --------------------------------------------------------------- */
(function () {
  'use strict';

  var GOOGLE_ADS_ID = 'AW-18397546166';
  // Libellé de l'action de conversion « Demande de polygraphie ».
  // À renseigner depuis Google Ads › Objectifs › Conversions.
  var CONVERSION_LABEL = '';

  var CLE = 'somnohub_consentement';
  var VERSION = 1;

  // ── Consent Mode v2 : tout refusé tant que le visiteur n'a pas choisi ──
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500
  });

  gtag('js', new Date());
  gtag('config', GOOGLE_ADS_ID, { anonymize_ip: true });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GOOGLE_ADS_ID;
  document.head.appendChild(s);

  // ── Mémorisation du choix ──
  function lire() {
    try {
      var brut = localStorage.getItem(CLE);
      if (!brut) return null;
      var o = JSON.parse(brut);
      return (o && o.v === VERSION) ? o : null;
    } catch (e) { return null; }
  }

  function ecrire(accepte) {
    try {
      localStorage.setItem(CLE, JSON.stringify({
        v: VERSION, accepte: accepte, date: new Date().toISOString()
      }));
    } catch (e) { /* navigation privée, stockage bloqué : sans conséquence */ }
  }

  function appliquer(accepte) {
    var etat = accepte ? 'granted' : 'denied';
    gtag('consent', 'update', {
      ad_storage: etat,
      ad_user_data: etat,
      ad_personalization: etat,
      analytics_storage: etat
    });
  }

  var choix = lire();
  if (choix) appliquer(choix.accepte);

  // ── Bandeau ──
  var STYLE = [
    '#sh-consent{position:fixed;left:0;right:0;bottom:0;z-index:99999;',
    'background:#ffffff;border-top:1px solid #d4e0d9;',
    'box-shadow:0 -6px 28px rgba(26,61,43,.16);',
    'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'padding:18px 20px;animation:sh-up .28s ease-out}',
    '@keyframes sh-up{from{transform:translateY(100%)}to{transform:translateY(0)}}',
    '#sh-consent .sh-in{max-width:960px;margin:0 auto;display:flex;gap:18px;',
    'align-items:center;flex-wrap:wrap;justify-content:space-between}',
    '#sh-consent p{margin:0;font-size:.9rem;line-height:1.55;color:#4a5e53;flex:1 1 380px}',
    '#sh-consent strong{color:#1a3d2b}',
    '#sh-consent a{color:#52b788;font-weight:600}',
    '#sh-consent .sh-btns{display:flex;gap:10px;flex:0 0 auto}',
    '#sh-consent button{font-family:inherit;font-size:.88rem;font-weight:700;',
    'padding:11px 20px;border-radius:8px;cursor:pointer;border:1px solid transparent;',
    'white-space:nowrap}',
    '#sh-consent .sh-ok{background:#1a3d2b;color:#fff}',
    '#sh-consent .sh-ok:hover{background:#2d6a4f}',
    '#sh-consent .sh-no{background:#fff;color:#4a5e53;border-color:#d4e0d9}',
    '#sh-consent .sh-no:hover{background:#f4f7f5}',
    '@media(max-width:620px){#sh-consent .sh-btns{width:100%}',
    '#sh-consent button{flex:1}}'
  ].join('');

  function afficher() {
    if (document.getElementById('sh-consent')) return;

    var css = document.createElement('style');
    css.textContent = STYLE;
    document.head.appendChild(css);

    var el = document.createElement('div');
    el.id = 'sh-consent';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Gestion des cookies');
    el.innerHTML =
      '<div class="sh-in">' +
        '<p><strong>Nous utilisons des cookies de mesure publicitaire.</strong> ' +
        'Ils nous permettent de savoir quelles annonces amènent des visiteurs sur le site. ' +
        'Aucune donnée de santé n\'est concernée. La mesure d\'audience du site fonctionne, elle, sans cookie. ' +
        '<a href="/mentions-legales.html">En savoir plus</a></p>' +
        '<div class="sh-btns">' +
          '<button type="button" class="sh-no">Refuser</button>' +
          '<button type="button" class="sh-ok">Accepter</button>' +
        '</div>' +
      '</div>';

    function repondre(accepte) {
      ecrire(accepte);
      appliquer(accepte);
      el.remove();
      try {
        if (window.umami) window.umami.track('consentement', { choix: accepte ? 'accepte' : 'refuse' });
      } catch (e) {}
    }

    el.querySelector('.sh-ok').addEventListener('click', function () { repondre(true); });
    el.querySelector('.sh-no').addEventListener('click', function () { repondre(false); });
    document.body.appendChild(el);
  }

  if (!choix) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', afficher);
    } else {
      afficher();
    }
  }

  // Permet de revenir sur son choix (lien « Gérer mes cookies » en pied de page)
  window.somnohubCookies = function () {
    try { localStorage.removeItem(CLE); } catch (e) {}
    afficher();
  };

  /* Conversion Google Ads.
   * Appelée à la validation d'une demande. Aucune donnée patient
   * n'est transmise : ni nom, ni adresse, ni téléphone, ni indication. */
  window.somnohubConversion = function () {
    if (!CONVERSION_LABEL) return;
    gtag('event', 'conversion', {
      send_to: GOOGLE_ADS_ID + '/' + CONVERSION_LABEL
    });
  };
})();
