import jwt from 'jsonwebtoken';
import { pool } from './db.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'vectorcoin' });
}
export async function authenticate(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
    const claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'vectorcoin' });
    const { rows } = await pool.query('SELECT id,email,display_name,role FROM users WHERE id=$1 AND is_active=true', [claims.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Аккаунт не найден или отключён' });
    req.user = rows[0]; next();
  } catch { return res.status(401).json({ error: 'Недействительный или просроченный токен' }); }
}
export const requireTeacher = (req,res,next) => req.user?.role === 'teacher'
  ? next() : res.status(403).json({error:'Доступ только для учителя'});
