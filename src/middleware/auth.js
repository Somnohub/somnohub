const jwt = require('jsonwebtoken');

function authMiddleware(roles = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = payload;

      if (roles.length > 0 && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  };
}

module.exports = authMiddleware;
