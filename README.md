# Pickup Concierge (v1)

Ionic React + Node personal assistant that takes a **natural-language request**, finds who to call, places human-sounding outbound calls via [Vapi](https://docs.vapi.ai/calls/outbound-calling) + Twilio, and summarizes the best outcome.

Restaurant pickup is one example. The same flow supports insurance shopping, appointments, reservations, and similar phone errands.

## Flow

1. Save your **profile** in Settings (name, phone, area via geolocation).
2. On Home, describe what you want in plain English.
3. OpenAI plans the mission and picks 1–3 businesses/companies to call.
4. Lookup finds phone numbers (Google Places if configured, else OpenAI web search).
5. Vapi dials from your Twilio number as you (natural voice, confirmation details).
6. When calls finish, you get a **best offer / outcome** summary.

## Project layout

- `frontend/` — Ionic React UI (Home, Settings, Mission status)
- `backend/` — Express API (`/api/missions`)
- `.env` — secrets (never commit)

## Setup

1. Copy `.env.example` → `.env` and fill values (including `VAPI_API_KEY`).
2. Install deps and run:

```bash
cd backend && npm install
cd ../frontend && npm install
npm run dev:api
npm run dev:web
```

- API: http://localhost:3001
- App: http://localhost:5173

## API

- `POST /api/missions` — `{ request, profile, dryRun? }`
- `GET /api/missions/:id` — status, transcripts, recommendation
- `POST /api/missions/:id/refresh` — force call-status refresh

## Security note

Rotate any keys that were shared outside `.env`.

## Deploy (Vercel)

Production: https://assistant-six-omega.vercel.app

The GitHub repo is connected to Vercel. Pushes to `main` auto-deploy production.

Local setup for Vercel CLI (optional):

```bash
npx vercel login
npx vercel --prod
```

Secrets live in the Vercel project Environment Variables (not in git).
