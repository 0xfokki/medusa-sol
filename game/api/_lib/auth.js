import { timingSafeEqual } from 'node:crypto';

export function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD || '';
  const given = (req.headers['x-admin-password'] || '').toString();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
