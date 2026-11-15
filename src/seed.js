import dotenv from 'dotenv'; dotenv.config();
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
const events = [
 ['Хакатон «Код будущего»','active',[
  ['Команда «Альфа»','10-А',540],['Команда «Бета»','10-Б',320],['Команда «Гамма»','9-В',210],['Профиль «IT»','11-А',2100]]],
 ['Олимпиада по информатике','active',[
  ['Участник: Алексей К.','10-А',120],['Участник: Мария С.','10-Б',80],['Участник: Иван Д.','11-А',200],['Участник: Ольга П.','9-В',60]]],
 ['Школьный квест','upcoming',[
  ['Команда «Искатели»','9-А',0],['Команда «Логика»','10-А',0],['Команда «Пифагор»','8-Б',0]]],
 ['Проектная неделя','upcoming',[
  ['Команда «Эко»','10-Б',0],['Команда «Техно»','11-А',0],['Команда «Дизайн»','9-В',0]]]
];
try {
  for(const [name,status,teams] of events) {
    const ev=await pool.query(`INSERT INTO events(name,status) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET status=EXCLUDED.status RETURNING id`,[name,status]);
    for(const [team,cls,balance] of teams)
      await pool.query(`INSERT INTO teams(event_id,name,class_name,balance) VALUES($1,$2,$3,$4)
        ON CONFLICT(event_id,name) DO NOTHING`,[ev.rows[0].id,team,cls,balance]);
  }
  const email=process.env.SEED_TEACHER_EMAIL;
  const password=process.env.SEED_TEACHER_PASSWORD;
  if(email && password) {
    const hash=await bcrypt.hash(password,12);
    const u=await pool.query(`INSERT INTO users(email,password_hash,display_name,role)
      VALUES(lower($1),$2,'VectorCoin Teacher','teacher') ON CONFLICT(email) DO UPDATE SET role='teacher'
      RETURNING id`,[email,hash]);
    const {rows}=await pool.query('SELECT id FROM events');
    for(const e of rows) await pool.query('INSERT INTO event_teachers(event_id,teacher_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,u.rows[0].id]);
    console.log('Teacher account created/updated:',email);
  }
  console.log('Demo events and teams seeded');
} finally { await pool.end(); }
