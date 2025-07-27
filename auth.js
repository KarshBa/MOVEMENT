// Basic HTTP auth for all routes.
// Reads ADMIN_USER and ADMIN_PASS from env.
// On failure, sends 401 with WWW-Authenticate header.

export function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).end();
  }
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');

  const ADMIN_USER = process.env.ADMIN_USER || '';
  const ADMIN_PASS = process.env.ADMIN_PASS || '';

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.set('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).end();
}
