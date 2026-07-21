import * as cheerio from "cheerio";
import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../admin";
import { Config, RawItem } from "../types";

const TRENDING_URL = "https://github.com/trending?since=weekly";
const RELEVANT_TOPICS = ["ai", "llm", "agent", "developer-tools", "machine-learning", "mcp"];

interface TrendingRepo {
  name: string;
  url: string;
  description: string;
  starsThisWeek: number;
}

function parseTrendingHtml(html: string): TrendingRepo[] {
  const $ = cheerio.load(html);
  const repos: TrendingRepo[] = [];

  $("article.Box-row").each((_, el) => {
    const card = $(el);
    const href = card.find("h2 a").attr("href")?.trim();
    if (!href) return;

    const name = href.replace(/^\//, "");
    const description = card.find("p.col-9").first().text().trim();
    const starsText = card.find("span.d-inline-block.float-sm-right").first().text();
    const starsMatch = starsText.match(/([\d,]+)\s+stars? this week/);
    const starsThisWeek = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ""), 10) : 0;

    repos.push({
      name,
      url: `https://github.com/${name}`,
      description,
      starsThisWeek,
    });
  });

  return repos;
}

function isRelevant(repo: TrendingRepo, keywords: string[]): boolean {
  const haystack = `${repo.name} ${repo.description}`.toLowerCase();
  const allTerms = [...keywords, ...RELEVANT_TOPICS];
  return allTerms.some((term) => haystack.includes(term.toLowerCase()));
}

export async function fetchGitHubTrending(weekId: string, config: Config): Promise<number> {
  try {
    const res = await fetch(TRENDING_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (ai-tool-digest weekly fetcher)" },
    });
    if (!res.ok) {
      throw new Error(`GitHub Trending fetch failed: HTTP ${res.status}`);
    }
    const html = await res.text();
    const repos = parseTrendingHtml(html);

    if (repos.length === 0) {
      logger.warn("github: page fetched but no repo cards parsed — markup may have changed");
      return 0;
    }

    const threshold = config.min_score_thresholds.github;
    const matched = repos.filter((r) => r.starsThisWeek >= threshold && isRelevant(r, config.keyword_filters));

    const batch = db.batch();
    const collection = db.collection("raw_items");

    for (const repo of matched) {
      const rawItem: RawItem = {
        source: "github",
        week_id: weekId,
        title: repo.name,
        url: repo.url,
        description: repo.description,
        score: repo.starsThisWeek,
        comments_count: 0,
        tags: [],
        fetched_at: Timestamp.now(),
        raw: repo as unknown as Record<string, unknown>,
      };
      batch.set(collection.doc(), rawItem);
    }

    if (matched.length > 0) {
      await batch.commit();
    }

    logger.info(`github: ${matched.length} items matched out of ${repos.length} fetched`);
    return matched.length;
  } catch (err) {
    logger.error("github: fetch/parse failed, returning 0 items", err);
    return 0;
  }
}
