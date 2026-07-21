// Standalone API connectivity/auth check for the AI Tool Digest pipeline.
// Run with: npm install && npm run test-apis
// No credentials required to test Hacker News and GitHub Trending.
// Product Hunt / Reddit / Anthropic checks are skipped (not failed) if their
// env vars are missing — fill in .env as you acquire each credential.

import 'dotenv/config';

const RESULTS = [];

function record(name, status, detail) {
  RESULTS.push({ name, status, detail });
  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ' }[status];
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

async function withTimeout(promise, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1. Hacker News — no auth
// ---------------------------------------------------------------------------
async function checkHackerNews() {
  try {
    const idsRes = await withTimeout((signal) =>
      fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal })
    );
    if (!idsRes.ok) throw new Error(`HTTP ${idsRes.status}`);
    const ids = await idsRes.json();
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('empty topstories list');

    const itemRes = await withTimeout((signal) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${ids[0]}.json`, { signal })
    );
    if (!itemRes.ok) throw new Error(`HTTP ${itemRes.status} fetching item ${ids[0]}`);
    const item = await itemRes.json();

    record('Hacker News', 'PASS', `${ids.length} top stories, sample: "${item.title}"`);
  } catch (err) {
    record('Hacker News', 'FAIL', err.message);
  }
}

// ---------------------------------------------------------------------------
// 2. GitHub Trending — scraped HTML, no auth, most fragile per PRD
// ---------------------------------------------------------------------------
async function checkGitHubTrending() {
  try {
    const res = await withTimeout((signal) =>
      fetch('https://github.com/trending?since=weekly', {
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (ai-tool-digest connectivity check)' },
      })
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Cheap structural check without pulling in cheerio for this script:
    // each trending repo is rendered as <h2 class="h3 lh-condensed"> ... <a href="/owner/repo" ...>
    const repoHeadingBlocks = html.match(/<h2 class="h3 lh-condensed">[\s\S]*?<\/h2>/g) || [];
    const repoLinkMatches = repoHeadingBlocks.filter((block) => /href="\/[^"/]+\/[^"/]+"/.test(block));
    if (repoLinkMatches.length === 0) {
      throw new Error(
        'page fetched but expected repo link pattern not found — GitHub markup likely changed, scraper will need rework'
      );
    }
    record('GitHub Trending', 'PASS', `page fetched, ~${repoLinkMatches.length} repo link matches found`);
  } catch (err) {
    record('GitHub Trending', 'FAIL', err.message);
  }
}

// ---------------------------------------------------------------------------
// 3. Product Hunt — GraphQL, requires PH_DEVELOPER_TOKEN
// ---------------------------------------------------------------------------
async function checkProductHunt() {
  const token = process.env.PH_DEVELOPER_TOKEN;
  if (!token) {
    record('Product Hunt', 'SKIP', 'PH_DEVELOPER_TOKEN not set in .env');
    return;
  }
  try {
    const query = `query { posts(first: 1, order: VOTES) { edges { node { name votesCount } } } }`;
    const res = await withTimeout((signal) =>
      fetch('https://api.producthunt.com/v2/api/graphql', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query }),
      })
    );
    const body = await res.json();
    if (!res.ok || body.errors) {
      throw new Error(`HTTP ${res.status} — ${body.errors ? JSON.stringify(body.errors) : 'unknown error'}`);
    }
    const post = body.data?.posts?.edges?.[0]?.node;
    record('Product Hunt', 'PASS', post ? `sample: "${post.name}" (${post.votesCount} votes)` : 'query ok, no posts returned');
  } catch (err) {
    record('Product Hunt', 'FAIL', err.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Reddit — OAuth2 client-credentials, requires REDDIT_CLIENT_ID/SECRET
// ---------------------------------------------------------------------------
async function checkReddit() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT || 'ai-tool-digest/0.1 (connectivity check)';

  if (!clientId || !clientSecret) {
    record('Reddit', 'SKIP', 'REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set in .env');
    return;
  }

  try {
    const tokenRes = await withTimeout((signal) =>
      fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent,
        },
        body: 'grant_type=client_credentials',
      })
    );
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok || !tokenBody.access_token) {
      throw new Error(`token request failed — HTTP ${tokenRes.status} — ${JSON.stringify(tokenBody)}`);
    }

    const topRes = await withTimeout((signal) =>
      fetch('https://oauth.reddit.com/r/artificial/top?t=week&limit=1', {
        signal,
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
          'User-Agent': userAgent,
        },
      })
    );
    const topBody = await topRes.json();
    if (!topRes.ok) throw new Error(`HTTP ${topRes.status} fetching r/artificial/top`);
    const sample = topBody.data?.children?.[0]?.data?.title;
    record('Reddit', 'PASS', sample ? `sample from r/artificial: "${sample}"` : 'auth ok, no posts returned');
  } catch (err) {
    record('Reddit', 'FAIL', err.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Anthropic (Claude API) — requires ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------
async function checkAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    record('Anthropic (Claude API)', 'SKIP', 'ANTHROPIC_API_KEY not set in .env');
    return;
  }
  try {
    const res = await withTimeout((signal) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        }),
      })
    );
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${body.error?.message || JSON.stringify(body)}`);
    const text = body.content?.[0]?.text?.trim();
    record('Anthropic (Claude API)', 'PASS', `model responded: "${text}"`);
  } catch (err) {
    record('Anthropic (Claude API)', 'FAIL', err.message);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('Running AI Tool Digest API checks...\n');

  await Promise.all([
    checkHackerNews(),
    checkGitHubTrending(),
    checkProductHunt(),
    checkReddit(),
    checkAnthropic(),
  ]);

  const passed = RESULTS.filter((r) => r.status === 'PASS').length;
  const failed = RESULTS.filter((r) => r.status === 'FAIL').length;
  const skipped = RESULTS.filter((r) => r.status === 'SKIP').length;

  console.log('\n--- Summary ---');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (${RESULTS.length} total)`);

  if (failed > 0) process.exitCode = 1;
}

main();
