import dotenv from 'dotenv'; dotenv.config();
import fs from 'node:fs/promises';
import { pool } from './db.js';
try { const sql=await fs.readFile(new URL('../db/schema.sql',import.meta.url),'utf8'); await pool.query(sql); console.log('Schema applied'); }
finally { await pool.end(); }
