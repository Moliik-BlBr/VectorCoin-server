import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { authenticate, signToken } from './auth.js';

const fail = (message,status=400) => Object.assign(new Error(message),{status});
const eventRole = async (client,eventId,user) => {
  const {rows}=await client.query(`SELECT
    EXISTS(SELECT 1 FROM event_teachers WHERE event_id=$1 AND teacher_id=$2) AS is_teacher,
    EXISTS(SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2) AS is_member,
    id,name,status FROM events WHERE id=$1`,[eventId,user.id]);
  if(!rows[0]) throw fail('Мероприятие не найдено',404);
  return rows[0];
};
const requireEventTeacher = async(client,eventId,user) => {
  const e=await eventRole(client,eventId,user);
  if(!e.is_teacher) throw fail('У вас нет прав учителя в этом мероприятии',403);
  return e;
};
const requireEventMember = async(client,eventId,user) => {
  const e=await eventRole(client,eventId,user);
  if(!e.is_member) throw fail('Сначала вступите в это мероприятие',403);
  return e;
};

export function createApp(io) {
  const app=express();
  app.use(helmet({contentSecurityPolicy:false}));
  const allowed=(process.env.CORS_ORIGIN||'').split(',').map(x=>x.trim()).filter(Boolean);
  app.use(cors({origin:(origin,cb)=>!origin||origin==='null'||allowed.includes(origin)||process.env.NODE_ENV!=='production'?cb(null,true):cb(new Error('Origin not allowed'))}));
  app.use(express.json({limit:'32kb'}));
  app.get('/health',(_req,res)=>res.json({ok:true,service:'VectorCoin API'}));

  app.post('/api/auth/register',async(req,res,next)=>{
    try {
      const p=z.object({email:z.string().email().max(254),password:z.string().min(8).max(100),display_name:z.string().trim().min(2).max(120),role:z.enum(['teacher','participant']).optional()}).parse(req.body);
      const hash=await bcrypt.hash(p.password,12);
      const {rows}=await pool.query(`INSERT INTO users(email,password_hash,display_name,role) VALUES(lower($1),$2,$3,'participant') RETURNING id,email,display_name,role`,[p.email,hash,p.display_name]);
      const user=rows[0]; res.status(201).json({token:signToken(user),user});
    } catch(e){if(e.code==='23505')return res.status(409).json({error:'Этот email уже зарегистрирован'});next(e);}
  });
  app.post('/api/auth/login',async(req,res,next)=>{
    try {
      const p=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
      const {rows}=await pool.query('SELECT id,email,display_name,role,password_hash FROM users WHERE email=lower($1) AND is_active=true',[p.email]);
      if(!rows[0]||!(await bcrypt.compare(p.password,rows[0].password_hash)))return res.status(401).json({error:'Неверный email или пароль'});
      const {password_hash,...user}=rows[0];res.json({token:signToken(user),user});
    }catch(e){next(e);}
  });
  app.get('/api/auth/me',authenticate,(req,res)=>res.json({user:req.user}));

  // Teachers create events; participants explicitly join an active event.
  app.get('/api/events',authenticate,async(req,res,next)=>{
    try {
      const {rows}=await pool.query(`SELECT e.id,e.name,e.status,e.created_at,
        EXISTS(SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=$1) AS joined,
        EXISTS(SELECT 1 FROM event_teachers et WHERE et.event_id=e.id AND et.teacher_id=$1) AS is_teacher,
        (SELECT count(*)::int FROM event_participants ep WHERE ep.event_id=e.id) AS participant_count
        FROM events e WHERE e.status='active' AND (
          $2='participant' OR EXISTS(SELECT 1 FROM event_teachers et WHERE et.event_id=e.id AND et.teacher_id=$1)
        ) ORDER BY e.created_at DESC`,[req.user.id,req.user.role]);
      res.json(rows);
    }catch(e){next(e);}
  });
  app.post('/api/events',authenticate,async(req,res,next)=>{
    try {
      if(req.user.role!=='teacher'&&req.user.role!=='admin')throw fail('Создавать мероприятия могут только учителя',403);
      const p=z.object({name:z.string().trim().min(2).max(80)}).parse(req.body);
      const client=await pool.connect();
      try {await client.query('BEGIN');const {rows}=await client.query("INSERT INTO events(name,status,created_by) VALUES($1,'active',$2) RETURNING id,name,status,created_at",[p.name,req.user.id]);await client.query('INSERT INTO event_teachers(event_id,teacher_id) VALUES($1,$2)',[rows[0].id,req.user.id]);await client.query('COMMIT');res.status(201).json({...rows[0],joined:false,is_teacher:true,participant_count:0});}
      catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }catch(e){next(e);}
  });
  app.post('/api/events/:eventId/join',authenticate,async(req,res,next)=>{
    try {
      if(req.user.role!=='participant')throw fail('В мероприятия вступают аккаунты участников',403);
      const e=await eventRole(pool,req.params.eventId,req.user);if(e.status!=='active')throw fail('Это мероприятие закрыто для вступления',409);
      const {rows}=await pool.query('INSERT INTO event_participants(event_id,user_id) VALUES($1,$2) ON CONFLICT(event_id,user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING event_id,user_id,balance,joined_at',[e.id,req.user.id]);
      io.to('event:'+e.id).emit('event:changed',{eventId:e.id});res.json({ok:true,membership:rows[0]});
    }catch(e){next(e);}
  });
  app.get('/api/events/:eventId',authenticate,async(req,res,next)=>{
    try {const e=await eventRole(pool,req.params.eventId,req.user);if(!e.is_teacher&&!e.is_member)throw fail('Нет доступа к мероприятию',403);res.json({id:e.id,name:e.name,status:e.status,is_teacher:e.is_teacher,is_member:e.is_member});}catch(e){next(e);}
  });
  app.get('/api/events/:eventId/wallet',authenticate,async(req,res,next)=>{
    try {await requireEventMember(pool,req.params.eventId,req.user);const {rows}=await pool.query(`SELECT ep.balance,u.id,u.display_name,u.email FROM event_participants ep JOIN users u ON u.id=ep.user_id WHERE ep.event_id=$1 AND ep.user_id=$2`,[req.params.eventId,req.user.id]);res.json(rows[0]);}catch(e){next(e);}
  });
  app.get('/api/events/:eventId/participants',authenticate,async(req,res,next)=>{
    try {
      const e=await eventRole(pool,req.params.eventId,req.user);if(!e.is_teacher&&!e.is_member)throw fail('Нет доступа к участникам мероприятия',403);
      const search=String(req.query.search||'').trim().slice(0,80);
      const {rows}=await pool.query(`SELECT u.id,u.display_name,u.email,ep.balance,ep.joined_at
        FROM event_participants ep JOIN users u ON u.id=ep.user_id
        WHERE ep.event_id=$1 AND u.is_active=true AND ($2='' OR u.display_name ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
        ORDER BY u.display_name,u.email LIMIT 100`,[req.params.eventId,search]);res.json(rows);
    }catch(e){next(e);}
  });
  app.get('/api/events/:eventId/transactions',authenticate,async(req,res,next)=>{
    try {
      const e=await eventRole(pool,req.params.eventId,req.user);if(!e.is_teacher&&!e.is_member)throw fail('Нет доступа к истории мероприятия',403);
      const {rows}=await pool.query(`SELECT tr.id,tr.transaction_type,tr.method,tr.amount,tr.details,tr.created_at,
        a.display_name actor_name,s.display_name sender_name,r.display_name recipient_name,
        s.email sender_email,r.email recipient_email
        FROM transactions tr LEFT JOIN users a ON a.id=tr.actor_id
        LEFT JOIN users s ON s.id=tr.sender_user_id LEFT JOIN users r ON r.id=tr.recipient_user_id
        WHERE tr.event_id=$1 ORDER BY tr.created_at DESC LIMIT 200`,[req.params.eventId]);res.json(rows);
    }catch(e){next(e);}
  });
  app.get('/api/qr/me',authenticate,async(req,res,next)=>{
    try {const {rows}=await pool.query('SELECT qr_token FROM users WHERE id=$1',[req.user.id]);res.json({payload:'VECTORCOIN:USER:'+rows[0].qr_token});}catch(e){next(e);}
  });
  app.get('/api/qr/resolve/:token',authenticate,async(req,res,next)=>{
    try {const token=String(req.params.token).replace(/^VECTORCOIN:USER:/,'');const {rows}=await pool.query('SELECT id,display_name,email FROM users WHERE qr_token=$1 AND is_active=true',[token]);if(!rows[0])throw fail('QR-код не распознан',404);res.json(rows[0]);}catch(e){next(e);}
  });

  // A single audited, atomic operation endpoint for manual and QR actions.
  app.post('/api/events/:eventId/operations',authenticate,async(req,res,next)=>{
    const parsed=z.object({action:z.enum(['credit','debit','transfer']),amount:z.number().int().positive().max(1000000),target_user_id:z.string().uuid().optional(),qr_payload:z.string().max(300).optional(),method:z.enum(['manual','qr','nfc']).default('manual')}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Проверьте тип операции, получателя и сумму (целое число от 1 до 1 000 000)'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');const event=await eventRole(client,req.params.eventId,req.user);
      const {action,amount,method}=parsed.data;
      if(action==='transfer') {if(!event.is_member||req.user.role!=='participant')throw fail('Переводить монеты могут только участники мероприятия',403);}
      else if(!event.is_teacher||req.user.role!=='teacher'&&req.user.role!=='admin')throw fail('Начислять и списывать валюту может только учитель этого мероприятия',403);
      let targetId=parsed.data.target_user_id;
      if(parsed.data.qr_payload){const token=parsed.data.qr_payload.replace(/^VECTORCOIN:USER:/,'');const q=await client.query('SELECT id FROM users WHERE qr_token=$1 AND is_active=true',[token]);if(!q.rows[0])throw fail('QR-код не найден',404);targetId=q.rows[0].id;}
      if(!targetId)throw fail('Не указан получатель');
      if(targetId===req.user.id)throw fail('Нельзя выполнить операцию со своим кошельком');
      const members=await client.query('SELECT user_id FROM event_participants WHERE event_id=$1 AND user_id=ANY($2::uuid[])',[event.id,[targetId,...(action==='transfer'?[req.user.id]:[])]]);
      const required=action==='transfer'?2:1;if(members.rows.length!==required)throw fail('Участник должен вступить в это мероприятие',403);
      const lockIds=(action==='transfer'?[req.user.id,targetId]:[targetId]).sort();
      const locked=await client.query('SELECT ep.user_id,ep.balance,u.display_name FROM event_participants ep JOIN users u ON u.id=ep.user_id WHERE ep.event_id=$1 AND ep.user_id=ANY($2::uuid[]) ORDER BY ep.user_id FOR UPDATE OF ep',[event.id,lockIds]);
      const target=locked.rows.find(x=>x.user_id===targetId);if(!target)throw fail('Участник не найден',404);
      let sender=null;
      if(action==='transfer'){sender=locked.rows.find(x=>x.user_id===req.user.id);if(!sender)throw fail('Кошелёк отправителя не найден',404);if(Number(sender.balance)<amount)throw fail('Недостаточно монет для перевода',409);}
      if(action==='debit'&&Number(target.balance)<amount)throw fail('У участника недостаточно монет для списания',409);
      let targetBalance;
      if(action==='credit') targetBalance=(await client.query('UPDATE event_participants SET balance=balance+$1 WHERE event_id=$2 AND user_id=$3 RETURNING balance',[amount,event.id,targetId])).rows[0].balance;
      if(action==='debit') targetBalance=(await client.query('UPDATE event_participants SET balance=balance-$1 WHERE event_id=$2 AND user_id=$3 RETURNING balance',[amount,event.id,targetId])).rows[0].balance;
      let senderBalance=null;
      if(action==='transfer'){
        senderBalance=(await client.query('UPDATE event_participants SET balance=balance-$1 WHERE event_id=$2 AND user_id=$3 RETURNING balance',[amount,event.id,req.user.id])).rows[0].balance;
        targetBalance=(await client.query('UPDATE event_participants SET balance=balance+$1 WHERE event_id=$2 AND user_id=$3 RETURNING balance',[amount,event.id,targetId])).rows[0].balance;
      }
      const type=action==='credit'?'teacher_credit':action==='debit'?'teacher_debit':'transfer';
      const senderId=action==='transfer'?req.user.id:null;
      const recipientId=targetId;
      const details={target_name:target.display_name,target_balance_after:Number(targetBalance),sender_balance_after:senderBalance===null?null:Number(senderBalance),source:method};
      const tx=(await client.query(`INSERT INTO transactions(event_id,actor_id,sender_user_id,recipient_user_id,amount,method,transaction_type,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,created_at`,[event.id,req.user.id,senderId,recipientId,amount,method==='qr'?'qr':method==='nfc'?'nfc':(action==='transfer'?'transfer':method),type,JSON.stringify(details)])).rows[0];
      await client.query('COMMIT');
      const payload={eventId:event.id,action,amount,targetUserId:targetId,targetBalance:Number(targetBalance),senderBalance:senderBalance===null?null:Number(senderBalance),transaction:tx};
      io.to('user:'+targetId).emit('wallet:updated',payload);if(senderId)io.to('user:'+senderId).emit('wallet:updated',payload);io.to('event:'+event.id).emit('transaction:created',payload);
      res.status(201).json(payload);
    }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
  });

  app.use((err,_req,res,_next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:err.issues.map(i=>i.message).join('; ')});console.error(err);res.status(err.status||500).json({error:err.status?err.message:'Внутренняя ошибка сервера'});});
  return app;
}
