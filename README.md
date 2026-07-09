# SiteScout — HSE field companion

A mobile-first PWA that helps people doing **site investigation / geotechnical / remote field work** spot health, safety and environment (HSE) issues — even without deep HSE training.

Three modules, one shareable record:

- **Scan** — take a photo of a work site (rig, excavation, access track). AI returns hazards and "things to look out for", including environmental flags (spills, sediment, weed/pathogen hygiene, heritage).
- **Pre-start** — no site yet? Review a JSEA/SWMS, or describe the planned job, and get gap-questions and hazards to plan for.
- **Journey** — plan the drive: rest breaks at the 2-hour rule, route/remote-driving hazards, and a check-in contact.

Results render on screen, save to a local history, and share via the phone's native share sheet. Works offline — captures queue and analyse when back in coverage.

> ⚠️ SiteScout **prompts a competent person**. It does not replace a formal risk assessment (JSEA/SWMS) or a qualified HSE advisor. Verify everything on site.

## Status — live (deployed & verified 2026-07-09)

| | |
|---|---|
| **App (PWA)** | <https://travis-coder712.github.io/sitescout/> |
| **Worker (AI proxy)** | `https://sitescout.travishughes-836.workers.dev` |
| **Repo** | <https://github.com/Travis-coder712/sitescout> |
| **Version** | v1.0.0 |

To use the app: open it on your phone → **Add to Home Screen** → tap **⚙** and enter the team **access code**.

### Deploying updates
- **App / PWA** — edit files in `pwa/`, then `git push` to `main`. GitHub Actions redeploys Pages automatically (triggers on `pwa/**`). Bump `APP_VERSION` in `pwa/app.js` to refresh cached installs.
- **Worker** — `cd worker && npx wrangler deploy` (already authenticated). Secrets persist; only re-run `wrangler secret put …` if the key or access code changes.

The **one-time setup** below is kept as a reference for standing the stack up from scratch (new account, or a fork).

## Architecture

```
iPhone PWA (GitHub Pages, static)  ──►  Cloudflare Worker (holds API key)  ──►  Anthropic (Claude vision)
```

The Worker keeps the Anthropic key server-side (never in the public app) and gates every request behind a shared team **access code**.

---

## Setup (one-time)

You need two free accounts: **Anthropic** (for the API key) and **Cloudflare** (to host the Worker).

### 1. Get an Anthropic API key
1. Go to <https://console.anthropic.com> → sign up → **API Keys** → **Create Key**.
2. Add a little credit under **Billing** (usage is a few cents per scan on Claude Sonnet).
3. Copy the key (starts with `sk-ant-...`). Keep it private.

### 2. Deploy the Worker to Cloudflare
1. Sign up at <https://dash.cloudflare.com> (free).
2. Install Node.js (<https://nodejs.org>) if you don't have it, then:
   ```bash
   cd ~/Claude/sitescout/worker
   npx wrangler login          # opens browser to authorise Cloudflare
   npx wrangler deploy         # prints your Worker URL, e.g. https://sitescout.<you>.workers.dev
   ```
3. Set the two secrets (you'll be prompted to paste each value):
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY   # paste your sk-ant-... key
   npx wrangler secret put ACCESS_CODE         # invent a code to share with your team
   ```
4. Copy the printed **Worker URL**.

### 3. Point the app at the Worker
Edit `pwa/config.js` and paste your Worker URL:
```js
window.SITESCOUT_CONFIG = { WORKER_URL: "https://sitescout.<you>.workers.dev" };
```

### 4. Publish the PWA (GitHub Pages)
1. Create a GitHub repo (e.g. `sitescout`) and push the contents of `pwa/` to it.
2. Repo **Settings → Pages** → deploy from `main` / root.
3. Also set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your Pages origin (e.g. `https://<user>.github.io`) and redeploy the Worker so the browser is allowed to call it.
4. Open the Pages URL on your iPhone → **Share → Add to Home Screen**.

### 5. First run
Open the app, tap **⚙**, enter the **access code** you chose in step 2. Share the code with your field team.

---

## Local test (recommended before going public)

Verify one real scan against a locally-running Worker — no Cloudflare deploy, no browser/CORS needed. You only need an Anthropic key.

```bash
cd ~/Claude/sitescout/worker
cp .dev.vars.example .dev.vars        # then edit: paste your sk-ant-... key + pick any ACCESS_CODE
npx wrangler dev                      # starts the Worker at http://localhost:8787
```

In a second terminal:
```bash
cd ~/Claude/sitescout/worker
# Fastest smoke test (no photo) — proves the key works:
curl -s -X POST http://localhost:8787 \
  -H "content-type: application/json" \
  -H "x-sitescout-access: <the ACCESS_CODE you set>" \
  -d '{"mode":"jsea","text":"Excavator test pits beside a rural road, one worker, summer."}' | jq .

# Full vision path — send a real site photo:
./test-scan.sh ~/path/to/site-photo.jpg
```
You should get back structured JSON (summary, hazards, questions…). Once that looks right, deploy for real (step 2 above) and you're confident the AI path works.

## Cost & safety notes
- Model: `claude-sonnet-5` (good vision accuracy, fast/cheap on mobile). Swap in `worker/worker.js` if you want deeper analysis (`claude-opus-4-8`) or enable adaptive thinking.
- The access code stops random public use. For extra protection, add a **Rate Limiting** rule in the Cloudflare dashboard on the Worker route.
- Photos are sent to Anthropic for analysis only; nothing is stored server-side. History lives on the device.

## Layout
```
pwa/      # the app (deploy this to GitHub Pages)
worker/   # the Cloudflare Worker proxy
```

## Follow-ups
- Add a "SiteScout" card to Studio + the Travis Dashboard once the Pages URL is live.
- Optional: PDF export of a scan for attaching to a formal safety-walk record.
