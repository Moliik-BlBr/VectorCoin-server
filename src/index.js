import dotenv from 'dotenv'; dotenv.config();
import http from 'node:http';
import fs from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { pool } from './db.js';

if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32)throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
const schema=await fs.readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
await pool.query(schema);
if(process.env.SEED_TEACHER_EMAIL&&process.env.SEED_TEACHER_PASSWORD){
  const bcrypt=(await import('bcryptjs')).default;
  const hash=await bcrypt.hash(process.env.SEED_TEACHER_PASSWORD,12);
  await pool.query(`INSERT INTO users(email,password_hash,display_name,role) VALUES(lower($1),$2,'VectorCoin Teacher','teacher') ON CONFLICT(email) DO UPDATE SET role='teacher',is_active=true`,[process.env.SEED_TEACHER_EMAIL,hash]);
  // Preserve management access to the legacy test event if one already exists.
  await pool.query(`INSERT INTO event_teachers(event_id,teacher_id) SELECT e.id,u.id FROM events e CROSS JOIN users u WHERE lower(e.name)='test' AND u.email=lower($1) ON CONFLICT DO NOTHING`,[process.env.SEED_TEACHER_EMAIL]);
}
const server=http.createServer();
const origins=[...(process.env.CORS_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean),'https://appassets.androidplatform.net'];
const io=new Server(server,{cors:{origin:origins.length?origins:true,methods:['GET','POST']}});
io.use(async(socket,next)=>{try{const claims=jwt.verify(socket.handshake.auth?.token,process.env.JWT_SECRET,{issuer:'vectorcoin'});const {rows}=await pool.query('SELECT id,role FROM users WHERE id=$1 AND is_active=true',[claims.sub]);if(!rows[0])return next(new Error('Unauthorized'));socket.user=rows[0];next();}catch{next(new Error('Unauthorized'));}});
io.on('connection',socket=>{
  socket.join('user:'+socket.user.id);
  socket.on('event:subscribe',async({eventId}={})=>{try{const {rows}=await pool.query(`SELECT 1 FROM event_teachers WHERE event_id=$1 AND teacher_id=$2 UNION SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 LIMIT 1`,[eventId,socket.user.id]);if(rows.length)socket.join('event:'+eventId);}catch(e){console.error(e);}});
});
const app=createApp(io);server.on('request',app);
const port=Number(process.env.PORT||3000);server.listen(port,()=>console.log(`VectorCoin API listening on :${port}`));
