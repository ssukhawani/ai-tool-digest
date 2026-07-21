# Action Plan — AI Tool Trend Digest Pipeline
## Phase-by-phase build guide with commands + manual steps + expected output per phase

Companion doc to `PRD.md`. Follow phases in order — each one is independently
testable before moving to the next.

**Stack assumption:** Node.js (TypeScript) for Cloud Functions, Firebase CLI
installed, gcloud CLI installed, an existing or new Google Cloud / Firebase
project.

---

## PHASE 0 — Project Setup (manual, ~30 min)

### 0.1 Create Firebase project
```bash
npm install -g firebase-tools
firebase login
firebase projects:create ai-tool-digest --display-name "AI Tool Digest"
```

### 0.2 Init Firebase in your local repo
```bash
mkdir ai-tool-digest && cd ai-tool-digest
firebase init
# Select: Firestore, Functions, Emulators
# Language: TypeScript
# Use existing project -> ai-tool-digest
```

### 0.3 Upgrade to Blaze plan (required for outbound network calls from
Cloud Functions, e.g. calling PH/HN/Claude APIs)
```bash
# Manual step — must be done in console (no CLI command for billing):
# https://console.firebase.google.com/project/ai-tool-digest/usage/details
# Attach a billing account. Free tier limits still apply; you will not be
# charged at this volume unless you drastically scale up.
```

### 0.4 Set default region to Singapore
All resources in this project (Firestore, Cloud Functions, Cloud Scheduler)
use `asia-southeast1` (Singapore) throughout this plan. Set it as the gcloud
default so you don't need to pass `--region`/`--location` on every command:
```bash
gcloud config set functions/region asia-southeast1
gcloud config set run/region asia-southeast1
```
Also set the region in `firebase.json` / each function's runtime options
(e.g. `setGlobalOptions({ region: "asia-southeast1" })` in
`functions/src/index.ts`) so deployed functions land in Singapore, not the
`us-central1` default.

### 0.5 Enable required Google Cloud APIs
```bash
gcloud config set project ai-tool-digest
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com
```

**Expected output:** `firebase projects:list` shows `ai-tool-digest`;
Firebase console shows Firestore + Functions enabled.

---

## PHASE 1 — Firestore Schema + Config Doc (manual + code, ~20 min)

### 1.1 Create Firestore database (if not auto-created)
```bash
gcloud firestore databases create --location=asia-southeast1
```

### 1.2 Manually seed the config doc
Go to Firebase Console → Firestore → Start collection → `config` →
doc id `pipeline` → add fields:
```json
{
  "keyword_filters": ["AI", "agent", "LLM", "MCP", "vibe coding", "SaaS"],
  "recipient_emails": ["you@example.com"],
  "min_score_thresholds": {
    "producthunt": 20,
    "hackernews": 50,
    "github": 0
  }
}
```

**Expected output:** `config/pipeline` document visible in Firestore console
with the fields above.

---

## PHASE 2 — Hacker News Fetcher (code, ~1-2 hrs, no auth needed — easiest first)

### 2.1 Build
Write `functions/src/sources/hackernews.ts`:
- Fetch `topstories.json` (limit to first 150 ids to bound cost)
- Fetch each item's details (batch with `Promise.all`, chunked)
- Filter by `keyword_filters` from config against title
- Filter by `score >= min_score_thresholds.hackernews`
- Normalize to `RawItem` shape, write to `raw_items` with `source: 'hackernews'`

### 2.2 Test locally
```bash
firebase emulators:start --only functions,firestore
# trigger via a local HTTP call, e.g.:
curl http://localhost:5001/ai-tool-digest/asia-southeast1/fetchHackerNews
```

**Expected output:** Firestore emulator UI (localhost:4000) shows new docs
in `raw_items` with `source: "hackernews"`, plausible titles/scores.

---

## PHASE 3 — Product Hunt Fetcher (manual account step + code, ~1-2 hrs)

### 3.1 Manual: get developer token
1. Go to https://www.producthunt.com/v2/oauth/applications
2. Create an application (any name, redirect URI can be `http://localhost`)
3. Copy the **Developer Token** (non-expiring, no OAuth flow needed for
   public read-only data)

### 3.2 Store token securely
```bash
echo -n "YOUR_PH_TOKEN" | gcloud secrets create PH_DEVELOPER_TOKEN --data-file=-
gcloud secrets add-iam-policy-binding PH_DEVELOPER_TOKEN \
  --member="serviceAccount:ai-tool-digest@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3.3 Build
Write `functions/src/sources/producthunt.ts`:
- GraphQL POST to `https://api.producthunt.com/v2/api/graphql`
- Query `posts(postedAfter: <week_start>, order: VOTES, first: 50)`
- Normalize + write to `raw_items` with `source: 'producthunt'`

**Expected output:** `raw_items` now also contains `source: "producthunt"`
docs with real vote counts matching what you see on producthunt.com that week.

---

## PHASE 4 — GitHub Trending Fetcher (code, ~1-2 hrs, most fragile — build last)

### 4.1 Build
Write `functions/src/sources/github.ts`:
- Fetch `https://github.com/trending?since=weekly` HTML
- Parse with `cheerio`, extract repo name, description, stars-this-week, url
- Wrap entire function body in try/catch — on any failure, log and return
  empty array (never throw up to the orchestrator)
- Normalize/write to `raw_items` with `source: 'github'`

**Expected output:** `raw_items` contains `source: "github"` docs; if the
scrape structure changes and parsing fails, function logs an error but the
overall pipeline (tested in Phase 5) still completes.

---

## PHASE 5 — Orchestrator: `collectSources` (code, ~1 hr)

### 5.1 Build
Write `functions/src/collectSources.ts`:
- HTTP-triggered function
- Computes current `week_id` (ISO week)
- Calls all 3 fetchers in parallel via `Promise.allSettled`
- Writes a `sources_status` summary doc so failures are visible

### 5.2 Deploy + manual trigger test
```bash
firebase deploy --only functions:collectSources
curl -X POST https://asia-southeast1-ai-tool-digest.cloudfunctions.net/collectSources
```

**Expected output:** within ~1-2 min, Firestore `raw_items` for the current
`week_id` populated from all 3 sources; if you check Cloud Logging
(`gcloud functions logs read collectSources`), you see one log line per
source with item counts, e.g. `producthunt: 42 items, hackernews: 18 items...`

---

## PHASE 6 — LLM Summarization: `summarizeDigest` (manual key + code, ~2-3 hrs)

### 6.1 Manual: get Anthropic API key
1. Go to https://console.anthropic.com → API Keys → create key

### 6.2 Store secret
```bash
echo -n "YOUR_ANTHROPIC_KEY" | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
```

### 6.3 Build
Write `functions/src/summarizeDigest.ts`:
- Reads all `raw_items` where `week_id == current`
- Serializes to compact JSON (strip `raw` field to save tokens)
- Sends to Claude with a system prompt instructing: cluster/dedupe, rank,
  write blurbs, pick one `pick_of_the_week`, return **strict JSON** matching
  the `Digest` interface from the PRD
- Parses response; on parse failure, falls back to a simple
  top-10-by-score digest with no LLM commentary (never let this step fail
  silently)
- Writes result to `digests/{week_id}` with `status: 'draft'`

### 6.4 Test
```bash
firebase deploy --only functions:summarizeDigest
curl -X POST https://asia-southeast1-ai-tool-digest.cloudfunctions.net/summarizeDigest
```

**Expected output:** `digests/{week_id}` doc appears in Firestore with
populated `top_picks`, `pick_of_the_week`, and `full_summary` — read it and
sanity-check the blurbs actually make sense against the raw items.

---

## PHASE 7 — Email Delivery (manual Apps Script setup + code, ~1-2 hrs)

### 7.1 Manual: create Apps Script Web App
1. Go to https://script.google.com → New Project
2. Paste:
```javascript
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  GmailApp.sendEmail(
    data.to,
    data.subject,
    "",
    { htmlBody: data.html }
  );
  return ContentService.createTextOutput(
    JSON.stringify({ status: "sent" })
  ).setMimeType(ContentService.MimeType.JSON);
}
```
3. Deploy → New deployment → type: **Web app** → Execute as: **Me** →
   Who has access: **Anyone** → Deploy
4. Copy the Web App URL

### 7.2 Store the URL
```bash
echo -n "YOUR_APPS_SCRIPT_URL" | gcloud secrets create APPS_SCRIPT_WEBHOOK_URL --data-file=-
```

### 7.3 Build
Write `functions/src/sendDigest.ts`:
- Reads `digests/{week_id}`
- Formats HTML (simple template — dark card style optional, plain HTML is
  fine for v1)
- POSTs `{ to, subject, html }` to the Apps Script URL
- On success, updates digest doc: `status: 'sent'`, `sent_at: now`
- On failure, retries up to 3x with backoff, logs final failure

### 7.4 Test
```bash
firebase deploy --only functions:sendDigest
curl -X POST https://asia-southeast1-ai-tool-digest.cloudfunctions.net/sendDigest
```

**Expected output:** email arrives in your inbox within ~1 min, formatted
digest with pick of the week clearly highlighted; `digests/{week_id}.status`
now reads `"sent"`.

---

## PHASE 8 — Scheduling (manual + code, ~30 min)

### 8.1 Create Cloud Scheduler jobs
```bash
gcloud scheduler jobs create http weekly-collect \
  --location=asia-southeast1 \
  --schedule="0 6 * * 1" \
  --time-zone="Asia/Kolkata" \
  --uri="https://asia-southeast1-ai-tool-digest.cloudfunctions.net/collectSources" \
  --http-method=POST

gcloud scheduler jobs create http weekly-summarize \
  --location=asia-southeast1 \
  --schedule="15 6 * * 1" \
  --time-zone="Asia/Kolkata" \
  --uri="https://asia-southeast1-ai-tool-digest.cloudfunctions.net/summarizeDigest" \
  --http-method=POST

gcloud scheduler jobs create http weekly-send \
  --location=asia-southeast1 \
  --schedule="25 6 * * 1" \
  --time-zone="Asia/Kolkata" \
  --uri="https://asia-southeast1-ai-tool-digest.cloudfunctions.net/sendDigest" \
  --http-method=POST
```

### 8.2 Secure the endpoints (recommended)
```bash
# Restrict functions to only be invoked by the Scheduler service account
gcloud functions add-invoker-policy-binding collectSources \
  --member="serviceAccount:ai-tool-digest@appspot.gserviceaccount.com"
# Repeat for summarizeDigest, sendDigest
```

**Expected output:** `gcloud scheduler jobs list` shows all 3 jobs; manually
run one with `gcloud scheduler jobs run weekly-collect --location=asia-southeast1` and confirm it
triggers the function (check Cloud Logging).

---

## PHASE 9 — End-to-End Test (manual, ~15 min)

1. Manually trigger all 3 scheduler jobs in sequence, 2 min apart:
```bash
gcloud scheduler jobs run weekly-collect --location=asia-southeast1
sleep 120
gcloud scheduler jobs run weekly-summarize --location=asia-southeast1
sleep 60
gcloud scheduler jobs run weekly-send --location=asia-southeast1
```
2. Check Firestore: `raw_items` populated, `digests/{week_id}` has
   `status: "sent"`
3. Check inbox: digest email received, content is coherent and useful

**Expected output:** a complete, real digest email in your inbox, generated
with zero manual research — this is the definition-of-done for v1.

---

## PHASE 10 — Monitoring & Hardening (ongoing, ~1 hr initial setup)

### 10.1 Basic alerting
```bash
gcloud alpha monitoring policies create \
  --notification-channels=<your-channel-id> \
  --display-name="Digest pipeline failure" \
  --condition-display-name="Cloud Function errors" \
  --condition-filter='resource.type="cloud_function" AND severity="ERROR"'
```
(Optional for v1 — can skip and just check email arrival manually for the
first month before automating alerts.)

### 10.2 Weekly manual check (first 4 weeks)
- Read `sources_status` in each digest doc — confirm which sources are
  reliably working
- Adjust `config/pipeline` thresholds/keywords based on digest quality
- If GitHub Trending scraper breaks (most likely), fix independently — rest
  of pipeline unaffected

---

## SUMMARY: BUILD TIME ESTIMATE

| Phase | Time | Manual step required? |
|---|---|---|
| 0. Setup | 30 min | Yes — billing, project creation |
| 1. Firestore schema | 20 min | Yes — seed config doc |
| 2. Hacker News fetcher | 1-2 hrs | No |
| 3. Product Hunt fetcher | 1-2 hrs | Yes — get dev token |
| 4. GitHub Trending fetcher | 1-2 hrs | No |
| 5. Orchestrator | 1 hr | No |
| 6. LLM summarization | 2-3 hrs | Yes — get Anthropic key |
| 7. Email delivery | 1-2 hrs | Yes — Apps Script deploy |
| 8. Scheduling | 30 min | Yes — gcloud scheduler setup |
| 9. E2E test | 15 min | No |
| 10. Monitoring | 1 hr | Optional |

**Total: ~9-14 hours — fits comfortably in your 1-2 day estimate at 4-6
hrs/day. (Reddit dropped from v1 scope; API connectivity for PH/HN/GitHub/Claude
already verified via `test-apis.mjs`.)**

---

*Action Plan Version: 1.1.0 — Reddit removed from v1 scope*
*Companion to PRD.md*
