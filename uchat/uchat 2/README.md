# UCHAT – random video chat with smart filters

Random 1:1 video + text chat for **verified adults (18+)**. Users choose who they meet by
**age range, country, language** (free) and **gender** (UCHAT Plus).

## Run it locally

```bash
npm install
npm run dev        # premium filters unlocked for testing
# or
npm start          # gender filter shows the paywall
```

Open http://localhost:3000 in two browser windows (or two devices on the same network),
fill in the profile, and press **Start chatting**. For testing in two windows on one
machine, run with `ALLOW_SAME_IP=true npm run dev` (same-IP matches are blocked by default).

## Put it online (free, ~15 minutes)

1. Create a free account at github.com, make a new repository called `uchat`, and upload
   all the files in this folder (drag and drop works; skip `node_modules`).
2. Create a free account at render.com → **New → Blueprint** → pick your `uchat` repo.
   `render.yaml` sets everything up. Your site goes live at `https://uchat-xxxx.onrender.com`.
3. Buy a domain (e.g. Namecheap or Cloudflare) and in Render → Settings → **Custom Domains**
   add it; copy the DNS records Render shows into your domain provider. HTTPS is automatic.
4. Upgrade Render to a paid plan ($7/month) before launch — the free plan sleeps when idle.

## How it works

- `server.js` – Express + Socket.io. Keeps a waiting queue and pairs two users only when
  **both** match each other's filters. Relays WebRTC signaling, text chat, reports and bans.
- `public/` – the web app: setup form, video call, chat, Next / Report / Stop, paywall.
- Video goes peer-to-peer over WebRTC; the server only does matchmaking.

## Before going live (required)

1. **HTTPS** – browsers only allow camera access on HTTPS. Deploy to Render, Railway or Fly.io.
2. **TURN server** – add one to `ICE_SERVERS` in `public/app.js` (Metered, Twilio, or coturn);
   without it ~15–20% of users can't connect.
3. **Real age verification** – replace the DOB gate with Yoti / Persona / Veriff.
4. **AI moderation** – sample video frames to a moderation API (Hive, Sightengine).
5. **Accounts + payments** – add Supabase/Firebase auth and Stripe Billing, then set
   `socket.data.premium` in `isPremium()` from the user's subscription.
6. **Persistence** – move queue/bans to Redis + a database to run multiple servers.
7. **Legal** – Terms, Privacy Policy, Community Guidelines reviewed by a lawyer.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | 3000 | Server port |
| `PREMIUM_DEV_MODE` | false | Unlock premium filters for testing |
| `REPORTS_TO_BAN` | 3 | Reports before an IP is banned |
| `ALLOW_SAME_IP` | false | Allow matching two tabs on the same network (testing) |
