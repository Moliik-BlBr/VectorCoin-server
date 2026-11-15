import dotenv from 'dotenv';
dotenv.config();
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { pool } from './db.js';

if(!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}
const server=http.createServer();
const origins=(process.env.CORS_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
const io=new Server(server,{cors:{origin:origins.length?origins:true,methods:['GET','POST']}});
io.use(async(socket,next)=>{
  try {
    const token=socket.handshake.auth?.token;
    const claims=jwt.verify(token,process.env.JWT_SECRET,{issuer:'vectorcoin'});
    const {rows}=await pool.query('SELECT id,role FROM users WHERE id=$1 AND is_active=true',[claims.sub]);
    if(!rows[0]) return next(new Error('Unauthorized'));
    socket.user=rows[0]; next();
  } catch { next(new Error('Unauthorized')); }
});
io.on('connection',socket=>{
  socket.on('event:subscribe',async({eventId}={})=>{
    try {
      const {rows}=await pool.query('SELECT 1 FROM event_teachers WHERE event_id=$1 AND teacher_id=$2 LIMIT 1',[eventId,socket.user.id]);
      if(rows.length) socket.join('event:'+eventId);
    } catch(e){ console.error(e); }
  });
  socket.on('team:subscribe',async({teamId}={})=>{
    try {
      const {rows}=await pool.query(`SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2
        UNION SELECT 1 FROM teams t JOIN event_teachers et ON et.event_id=t.event_id
        WHERE t.id=$1 AND et.teacher_id=$2 LIMIT 1`,[teamId,socket.user.id]);
      if(rows.length) socket.join('team:'+teamId);
    } catch(e){ console.error(e); }
  });
});
const app=createApp(io);
server.on('request',app);
const port=Number(process.env.PORT||3000);
server.listen(port,()=>console.log(`VectorCoin API listening on :${port}`));
