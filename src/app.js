import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { authenticate, requireTeacher, signToken } from './auth.js';

export function createApp(io) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  const allowed = (process.env.CORS_ORIGIN || '').split(',').map(x=>x.trim()).filter(Boolean);
  app.use(cors({ origin: (origin, cb) => !origin || origin === 'null' || allowed.includes(origin) || process.env.NODE_ENV !== 'production' ? cb(null,true) : cb(new Error('Origin not allowed')) }));
  app.use(express.json({limit:'32kb'}));

  app.get('/health', (_req,res)=>res.json({ok:true,service:'VectorCoin API'}));

  const registerSchema = z.object({
    email:z.string().email().max(254), password:z.string().min(8).max(100),
    display_name:z.string().trim().min(2).max(120),
    role:z.enum(['teacher','participant'])
  });
  app.post('/api/auth/register', async (req,res,next)=>{
    try {
      const p=registerSchema.parse(req.body);
      // Public self-registration as teacher is disabled by default. Promote via admin SQL.
      if(p.role==='teacher') return res.status(403).json({error:'Регистрация учителя доступна только после приглашения администратора. Зарегистрируйтесь как участник.'});
      const hash=await bcrypt.hash(p.password,12);
      const {rows}=await pool.query(
        'INSERT INTO users(email,password_hash,display_name,role) VALUES(lower($1),$2,$3,$4) RETURNING id,email,display_name,role',
        [p.email,hash,p.display_name,p.role]);
      res.status(201).json({token:signToken(rows[0]),user:rows[0]});
    } catch(e){ if(e.code==='23505') return res.status(409).json({error:'Этот email уже зарегистрирован'}); next(e); }
  });
  app.post('/api/auth/login', async (req,res,next)=>{
    try {
      const p=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
      const {rows}=await pool.query('SELECT id,email,display_name,role,password_hash FROM users WHERE email=lower($1) AND is_active=true',[p.email]);
      if(!rows[0] || !(await bcrypt.compare(p.password,rows[0].password_hash))) return res.status(401).json({error:'Неверный email или пароль'});
      const {password_hash,...user}=rows[0];
      res.json({token:signToken(user),user});
    } catch(e){next(e);}
  });
  app.get('/api/auth/me',authenticate,(req,res)=>res.json({user:req.user}));

  app.get('/api/events',authenticate,async (_req,res,next)=>{
    try { const {rows}=await pool.query('SELECT id,name,status,starts_at,ends_at FROM events WHERE status IN (\'active\',\'upcoming\') ORDER BY starts_at NULLS LAST,name'); res.json(rows); } catch(e){next(e);}
  });
  app.get('/api/events/:eventId/teams',authenticate,async(req,res,next)=>{
    try {
      const {rows}=await pool.query(`SELECT t.id,t.name,t.class_name,t.balance,COUNT(tm.user_id)::int member_count
        FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id
        WHERE t.event_id=$1 GROUP BY t.id ORDER BY t.name`,[req.params.eventId]);
      res.json(rows);
    } catch(e){next(e);}
  });
  app.get('/api/teams',authenticate,async(_req,res,next)=>{
    try {
      const {rows}=await pool.query(`SELECT t.id,t.name,t.class_name,t.balance,t.event_id,
        COUNT(tm.user_id)::int member_count FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id
        WHERE t.is_open=true GROUP BY t.id ORDER BY t.name`);
      res.json(rows);
    } catch(e){next(e);}
  });
  app.post('/api/teams/:teamId/join',authenticate,async(req,res,next)=>{
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const team=await client.query('SELECT id,event_id,is_open FROM teams WHERE id=$1 FOR UPDATE',[req.params.teamId]);
      if(!team.rows[0] || !team.rows[0].is_open) throw Object.assign(new Error('Команда недоступна'),{status:404});
      await client.query('INSERT INTO team_members(team_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.params.teamId,req.user.id]);
      await client.query('COMMIT');
      res.json({ok:true,teamId:req.params.teamId});
    } catch(e){await client.query('ROLLBACK');next(e);} finally{client.release();}
  });
  app.post('/api/teams/:teamId/credit',authenticate,requireTeacher,async(req,res,next)=>{
    const parsed=z.object({amount:z.number().int().positive().max(1000000),method:z.enum(['manual','qr','nfc']).default('manual')}).safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:'Сумма должна быть целым числом от 1 до 1 000 000'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query(`SELECT t.id,t.name,t.event_id FROM teams t
        JOIN event_teachers et ON et.event_id=t.event_id
        WHERE t.id=$1 AND et.teacher_id=$2 FOR UPDATE OF t`,[req.params.teamId,req.user.id]);
      if(!q.rows[0]) throw Object.assign(new Error('У вас нет прав начислять монеты этой команде'),{status:403});
      const team=q.rows[0], amount=parsed.data.amount;
      const updated=await client.query('UPDATE teams SET balance=balance+$1,updated_at=now() WHERE id=$2 RETURNING balance',[amount,team.id]);
      const tx=await client.query(`INSERT INTO transactions(event_id,team_id,actor_id,amount,method)
        VALUES($1,$2,$3,$4,$5) RETURNING id,amount,method,created_at`,
        [team.event_id,team.id,req.user.id,amount,parsed.data.method]);
      await client.query('COMMIT');
      const payload={teamId:team.id,eventId:team.event_id,balance:Number(updated.rows[0].balance),transaction:tx.rows[0]};
      io.to('team:'+team.id).emit('team:updated',payload);
      io.to('event:'+team.event_id).emit('transaction:created',{...payload,team_name:team.name});
      res.status(201).json(payload);
    } catch(e){await client.query('ROLLBACK');next(e);} finally{client.release();}
  });
  app.get('/api/events/:eventId/transactions',authenticate,async(req,res,next)=>{
    try {
      const {rows}=await pool.query(`SELECT tr.id,tr.amount,tr.method,tr.created_at,t.name team_name
        FROM transactions tr JOIN teams t ON t.id=tr.team_id
        WHERE tr.event_id=$1 ORDER BY tr.created_at DESC LIMIT 200`,[req.params.eventId]);
      res.json(rows);
    } catch(e){next(e);}
  });

  app.use((err,_req,res,_next)=>{
    if(err instanceof z.ZodError) return res.status(400).json({error:err.issues.map(i=>i.message).join('; ')});
    console.error(err);
    res.status(err.status || 500).json({error:err.status ? err.message : 'Внутренняя ошибка сервера'});
  });
  return app;
}
