# VectorCoin API (Railway)

Node.js + Express + PostgreSQL + Socket.IO. All wallet mutations are performed on the server inside PostgreSQL transactions. The Android client never changes balances locally.

## Railway deployment / update

1. Push the contents of this `server` directory to the GitHub repository connected to Railway (repository root should contain `Dockerfile`, `package.json`, `src/` and `db/`).
2. Keep the existing Railway PostgreSQL service and its `DATABASE_URL` reference.
3. Keep `JWT_SECRET` (32+ random characters), `SEED_TEACHER_EMAIL`, and `SEED_TEACHER_PASSWORD` configured in Railway Variables. Do not commit `.env` or secrets.
4. Deploy. `src/index.js` applies the idempotent SQL schema before listening. Existing users and existing event memberships are retained. The first migration copies old global balances into memberships in the legacy `test` event once; new balances are event-specific.
5. Open `https://YOUR-RAILWAY-DOMAIN/health`; expect `{ "ok": true, "service": "VectorCoin API" }`.

## Roles and event workflow

- Registration creates participant accounts only. Teacher accounts are provisioned by an administrator through the seed variables or directly in the database.
- A teacher creates an event with `POST /api/events`. The creating teacher is assigned to that event.
- Participants see active events in `GET /api/events` and explicitly join with `POST /api/events/:eventId/join`.
- Each event membership has its own balance (`event_participants.balance`).

## Wallet and QR rules

- Every user has a random, server-generated `qr_token`. `GET /api/qr/me` returns the payload for their personal QR. The QR identifies the user only; it is not a payment authorization credential.
- A participant can transfer coins to another participant in the same event.
- A teacher assigned to an event can credit or debit a participant in that event.
- QR and manual operations use `POST /api/events/:eventId/operations`.
- Every successful credit, debit, or transfer updates balances and inserts an immutable audit row in `transactions` in the same SQL transaction. If the ledger insert fails, the balance update rolls back too.
- The API checks event membership, teacher permissions, positive integer amounts, sufficient balance, and prevents self-transfers. QR operations require an authenticated user and explicit in-app confirmation.
- `GET /api/events/:eventId/transactions` returns the event audit history. Socket.IO broadcasts refresh notifications only; PostgreSQL remains the source of truth.

## Main endpoints

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/events`, `POST /api/events`, `POST /api/events/:eventId/join`, `GET /api/events/:eventId`
- `GET /api/events/:eventId/wallet`, `GET /api/events/:eventId/participants?search=name-or-email`
- `GET /api/events/:eventId/transactions`
- `GET /api/qr/me`, `GET /api/qr/resolve/:token`
- `POST /api/events/:eventId/operations`

Operation request examples:

```json
{"action":"transfer","target_user_id":"USER_UUID","amount":15,"method":"manual"}
{"action":"credit","qr_payload":"VECTORCOIN:USER:QR_TOKEN","amount":25,"method":"qr"}
{"action":"debit","target_user_id":"USER_UUID","amount":5,"method":"manual"}
```

## Security notes

- Use HTTPS on Railway. Never expose `DATABASE_URL` or `JWT_SECRET` in the Android app.
- Do not make the QR token an authorization secret: it only identifies the account. The API always authenticates the actor and checks role, event membership, and balance.
- For production deployment, restrict `CORS_ORIGIN` to trusted web origins if serving a web client. The Android WebView uses the fixed secure local origin `https://appassets.androidplatform.net`, which is explicitly allowed by the API and Socket.IO CORS configuration.
- Consider adding email verification, password recovery, rate limiting, and a teacher administration workflow before public launch.
