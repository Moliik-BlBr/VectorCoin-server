# VectorCoin — собственный backend

Node.js 20+, Express, PostgreSQL 16, JWT, bcrypt, Socket.IO.

## Что реализовано
- Регистрация участника и вход по email/паролю.
- Пароли хранятся только в виде bcrypt-хеша.
- JWT-доступ к API.
- События и команды из исходного HTML перенесены в seed.
- Вступление участника в команду.
- Начисление монет учителем только на закреплённом за ним мероприятии.
- Обновление баланса и запись транзакции выполняются в одной транзакции PostgreSQL.
- Socket.IO уведомляет подключённых клиентов о новых балансах/операциях.
- Ограничение суммы начисления и проверка входных данных.

## Локальный запуск (Docker)
1. Установите Docker Desktop.
2. Скопируйте `.env.example` в `.env`.
3. Заполните `POSTGRES_PASSWORD`, `JWT_SECRET` (длинная случайная строка), `CORS_ORIGIN`.
4. Чтобы создать первого учителя, задайте `SEED_TEACHER_EMAIL` и `SEED_TEACHER_PASSWORD` в `.env`.
5. `docker compose up --build -d`
6. Проверка: `curl http://localhost:3000/health`

Пример `.env`:
```
POSTGRES_PASSWORD=replace-this-long-db-password
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://YOUR_DOMAIN
SEED_TEACHER_EMAIL=teacher@example.org
SEED_TEACHER_PASSWORD=use-a-long-unique-password
```
После первого запуска удалите `SEED_TEACHER_PASSWORD` из `.env` и перезапустите контейнер API.

## Важная настройка роли учителя
Открытая регистрация учителем запрещена. Первый учитель создаётся через seed. Новых учителей добавляйте администратором, затем связывайте их с мероприятиями через `event_teachers`. Не выдавайте роль teacher публичным endpoint'ом.

Пример SQL для второго учителя:
```
UPDATE users SET role='teacher' WHERE email='second@example.org';
INSERT INTO event_teachers(event_id,teacher_id)
SELECT e.id,u.id FROM events e CROSS JOIN users u
WHERE e.name='Хакатон «Код будущего»' AND u.email='second@example.org'
ON CONFLICT DO NOTHING;
```

## Развёртывание в интернете
Размещайте API за HTTPS reverse proxy (Caddy/Nginx/Traefik), не публикуйте порт PostgreSQL.
Укажите публичный адрес `https://api.example.org` в `android/app/src/main/assets/config.js`.
В `CORS_ORIGIN` перечислите web-origin приложения/админки. Для Android WebView запросы идут с локального origin; при необходимости разрешите `null` origin на уровне reverse proxy/CORS только после оценки риска. Токен передаётся в Authorization header и Socket.IO handshake.
Сделайте резервное копирование PostgreSQL и настройте firewall, обновления ОС и мониторинг.

## API
- `POST /api/auth/register` `{email,password,display_name,role:"participant"}`
- `POST /api/auth/login` `{email,password}`
- `GET /api/auth/me`
- `GET /api/events`
- `GET /api/events/:eventId/teams`
- `GET /api/teams`
- `POST /api/teams/:teamId/join`
- `POST /api/teams/:teamId/credit` `{amount,method:"manual"}` — только учитель, закреплённый за событием
- `GET /api/events/:eventId/transactions`

Realtime: Socket.IO `team:subscribe` с `{teamId}`; сервер шлёт `team:updated` и `transaction:created`.

## Ограничения текущего этапа
- NFC и настоящий QR не подключены: в исходном HTML QR был CSS-макетом, а не кодом.
- Покупки/списание монет не реализованы в исходном интерфейсе, поэтому здесь не добавлялись.
- Учительская регистрация через приложение намеренно закрыта.
- Для production рекомендуется добавить подтверждение email, rate limiting, refresh tokens, аудит админских действий и тесты.
