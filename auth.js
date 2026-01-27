// Basic HTTP auth for all routes.
// Reads ADMIN_USER/ADMIN_PASS plus optional USER1_USER/USER1_PASS and USER2_USER/USER2_PASS from env.
// On failure, sends 401 with WWW-Authenticate header.

function logAuthEvent({ ok, user, role, req }) {
  const ts = new Date().toISOString();
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const ua = req.headers['user-agent'] || 'unknown';


  if (ok) {
    console.log(`[AUTH OK] ${ts} user=${user} role=${role} ip=${ip} ua="${ua}"`);
  } else {
    console.warn(`[AUTH FAIL] ${ts} attempted_user="${user || 'none'}" ip=${ip} ua="${ua}"`);
  }
}

export function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).end();
  }
  let user = '', pass = '';
  try {
    [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  } catch {}

  // Collect configured users (ignore unset pairs)
  const candidates = [
    { login: process.env.ADMIN_USER, password: process.env.ADMIN_PASS, role: 'admin' },
    { login: process.env.USER1_USER, password: process.env.USER1_PASS, role: 'user' },
    { login: process.env.USER2_USER, password: process.env.USER2_PASS, role: 'user' },
    { login: process.env.USER3_USER, password: process.env.USER3_PASS, role: 'user' },
  ].filter(u => u.login && u.password);

  const match = candidates.find(u => u.login === user && u.password === pass);
  if (match) {
    // Expose identity/role to downstream handlers if needed
    req.user = { name: match.login, role: match.role };
    // Log successful auth
    logAuthEvent({ ok: true, user: match.login, role: match.role, req });

    return next();
  }

  // Log failed auth attempt (never log password)
  logAuthEvent({ ok: false, user, req });

  res.set('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).end();
}

// (Optional) gate admin-only routes
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin only' });
}
