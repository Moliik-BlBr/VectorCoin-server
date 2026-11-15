import dotenv from 'dotenv'; dotenv.config();
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
try {
  const email=process.env.SEED_TEACHER_EMAIL,password=process.env.SEED_TEACHER_PASSWORD;
  if(email&&password){
    const hash=await bcrypt.hash(password,12);
    await pool.query(`INSERT INTO users(email,password_hash,display_name,role) VALUES(lower($1),$2,'VectorCoin Teacher','teacher') ON CONFLICT(email) DO UPDATE SET role='teacher',is_active=true`,[email,hash]);
  }
  console.log('Teacher bootstrap completed; existing events and memberships preserved');
} finally { await pool.end(); }
