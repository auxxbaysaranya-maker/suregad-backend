# SureGad — API server

Backend for SureGad, a marketplace for used and refurbished phones and laptops with optional physical inspection.

Express 4 + TypeScript on Node 22, MongoDB (Mongoose), Socket.IO for live chat, Firebase Admin for sign-in, Razorpay for payments, Cloudinary or S3 for uploads, and BullMQ (Redis) for notification jobs.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI and the other values you need
npm run seed              # system data: roles, plans, categories, inspection checklists
npm run dev               # http://localhost:4000
```

`npm run seed:demo` adds demo users and listings for local testing.

For local sign-in without Firebase, set `ALLOW_DEV_AUTH=true` and a `DEV_AUTH_SECRET`. This switch is ignored when `NODE_ENV=production`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the API with reload on change |
| `npm run build` | Bundle to `dist/server.cjs` |
| `npm start` | Run the bundle |
| `npm test` | Vitest suite (database cases need an in-memory MongoDB binary) |
| `npm run lint` | Type-check |
| `npm run seed` / `seed:demo` | Seed system data / demo data |

## Configuration

Every setting is an environment variable; see `.env.example` for the full list with notes. The important ones:

- `MONGODB_URI` — MongoDB connection string.
- `CLIENT_ORIGIN` — comma-separated browser origins allowed by CORS and Socket.IO, e.g. `https://auxxbaysaranya-maker.github.io`.
- `API_PUBLIC_URL` — public URL of this API (used to build media links).
- `DATA_ENCRYPTION_KEY` — 32+ characters; required before IMEI, serial or bank numbers can be stored.
- `FIREBASE_*` — Firebase Admin service account for verifying sign-in tokens.
- `PAYMENT_PROVIDER=razorpay` with `RAZORPAY_*` keys. Mock payments are refused in production.
- `CLOUDINARY_*` or `S3_*` — required for uploads in production.

Never commit `.env`. `GET /api/v1/system/status` shows which integrations are configured, without revealing secrets.

## API overview

- `/api/v1/health`, `/api/v1/system/status`
- `/api/v1/auth/*` — Firebase session, profile, seller/business/partner onboarding
- `/api/v1/products`, `/marketplace/home`, `/sellers/:slug`, `/stores/:slug`
- `/api/v1/chat/*` — conversations, messages, offers, read receipts, block/report, seller contact
- `/api/v1/cart`, `/checkout`, `/payments/*` (Razorpay webhook at `/payments/webhooks/razorpay`)
- `/api/v1/inspections/*`, `/partner/*`, `/admin/*`
- Socket.IO on the same origin (`/socket.io`) for live chat, typing and presence.

## Deploying

Run it on any Node 22 host that supports long-lived WebSocket connections (a VPS with PM2 and Nginx, Render, Railway, Fly.io, etc.):

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Serve it over HTTPS, set `CLIENT_ORIGIN` to the web app's origin, and point the Razorpay webhook at `https://<api-host>/api/v1/payments/webhooks/razorpay`.
