import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../admin";
import { Config, RawItem } from "../types";

const TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const MAX_STORIES = 150;
const BATCH_SIZE = 20;

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  type?: string;
}

function matchesKeywords(item: HnItem, keywords: string[]): boolean {
  const haystack = `${item.title ?? ""} ${item.text ?? ""}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function fetchItem(id: number): Promise<HnItem | null> {
  const res = await fetch(ITEM_URL(id));
  if (!res.ok) return null;
  return (await res.json()) as HnItem;
}

async function fetchItemsInBatches(ids: number[]): Promise<HnItem[]> {
  const results: HnItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const items = await Promise.all(chunk.map(fetchItem));
    results.push(...items.filter((item): item is HnItem => item !== null));
  }
  return results;
}

export async function fetchHackerNews(weekId: string, config: Config): Promise<number> {
  const idsRes = await fetch(TOP_STORIES_URL);
  if (!idsRes.ok) {
    throw new Error(`Hacker News topstories fetch failed: HTTP ${idsRes.status}`);
  }
  const allIds = (await idsRes.json()) as number[];
  const ids = allIds.slice(0, MAX_STORIES);

  const items = await fetchItemsInBatches(ids);
  const threshold = config.min_score_thresholds.hackernews;

  const matched = items.filter(
    (item) =>
      item.type === "story" &&
      typeof item.score === "number" &&
      item.score >= threshold &&
      matchesKeywords(item, config.keyword_filters)
  );

  const batch = db.batch();
  const collection = db.collection("raw_items");

  for (const item of matched) {
    const rawItem: RawItem = {
      source: "hackernews",
      week_id: weekId,
      title: item.title ?? "(untitled)",
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
      description: item.text ?? "",
      score: item.score ?? 0,
      comments_count: item.descendants ?? 0,
      tags: [],
      fetched_at: Timestamp.now(),
      raw: item as unknown as Record<string, unknown>,
    };
    batch.set(collection.doc(), rawItem);
  }

  if (matched.length > 0) {
    await batch.commit();
  }

  logger.info(`hackernews: ${matched.length} items matched out of ${items.length} fetched`);
  return matched.length;
}
