import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { currentWeekId } from "./weekId";
import { Digest, DigestTopPick, RawItem, SourceName } from "./types";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const SYSTEM_PROMPT = `You are curating a weekly digest of AI/dev-tool news for a solo builder who
makes videos and ships small products. You are given a JSON array of raw items scraped from
Product Hunt, Hacker News, and GitHub Trending for one week.

Your task:
1. Cluster near-duplicate items across sources (the same tool/story mentioned on multiple
   sources should become ONE entry; merge their sources into a single item, keep the highest score).
2. Drop pure noise / low-signal items unlikely to matter to a builder.
3. Rank the remaining items by builder-relevance, not raw popularity.
4. Write a 1-2 sentence "why this matters to a builder" blurb per surviving item.
5. Select exactly one pick_of_the_week from the survivors.
6. Write a short narrative paragraph (full_summary) summarizing the week's themes.

Return ONLY strict JSON matching this exact TypeScript shape, no prose outside the JSON:
{
  "top_picks": [
    { "title": string, "url": string, "source": string, "category": string, "why_it_matters": string, "score": number }
  ],
  "pick_of_the_week": { "title": string, "url": string, "source": string, "category": string, "why_it_matters": string, "score": number },
  "full_summary": string
}
top_picks should have 5-8 items. Return valid JSON only, no markdown code fences.`;

interface LlmDigestShape {
  top_picks: DigestTopPick[];
  pick_of_the_week: DigestTopPick;
  full_summary: string;
}

function buildFallbackDigest(items: RawItem[]): LlmDigestShape {
  const sorted = [...items].sort((a, b) => b.score - a.score).slice(0, 10);
  const top_picks: DigestTopPick[] = sorted.map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    category: "uncategorized",
    why_it_matters: "(LLM summarization unavailable this week — raw top items shown by score.)",
    score: item.score,
  }));
  return {
    top_picks,
    pick_of_the_week: top_picks[0] ?? {
      title: "No items this week",
      url: "",
      source: "none",
      category: "none",
      why_it_matters: "No items were collected this week.",
      score: 0,
    },
    full_summary:
      "LLM summarization failed this week, so this digest shows the raw top 10 items by score without commentary.",
  };
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

async function callClaude(items: RawItem[], apiKey: string): Promise<LlmDigestShape> {
  const client = new Anthropic({ apiKey });
  const compactItems = items.map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    description: item.description,
    score: item.score,
    comments_count: item.comments_count,
    tags: item.tags,
  }));

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(compactItems) }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    logger.error(`summarizeDigest: no text block, stop_reason=${message.stop_reason}`);
    throw new Error("Claude response contained no text block");
  }

  const parsed = JSON.parse(stripCodeFences(textBlock.text)) as LlmDigestShape;
  if (!Array.isArray(parsed.top_picks) || !parsed.pick_of_the_week || typeof parsed.full_summary !== "string") {
    throw new Error("Claude response did not match expected Digest shape");
  }
  return parsed;
}

export const summarizeDigest = onRequest(
  { secrets: [anthropicApiKey], timeoutSeconds: 300, memory: "512MiB" },
  async (req, res) => {
    const weekId = currentWeekId();

    const itemsSnap = await db.collection("raw_items").where("week_id", "==", weekId).get();
    const items = itemsSnap.docs.map((d) => d.data() as RawItem);

    const statusDoc = await db.doc(`raw_items_status/${weekId}`).get();
    const sourcesStatus =
      (statusDoc.data()?.sources_status as Record<SourceName, "ok" | "failed">) ?? {
        hackernews: "failed",
        producthunt: "failed",
        github: "failed",
      };

    let llmResult: LlmDigestShape;
    try {
      llmResult = await callClaude(items, anthropicApiKey.value());
    } catch (err) {
      logger.error("summarizeDigest: Claude call/parse failed, using fallback digest", err);
      llmResult = buildFallbackDigest(items);
    }

    const digest: Digest = {
      week_id: weekId,
      generated_at: Timestamp.now(),
      sent_at: null,
      status: "draft",
      top_picks: llmResult.top_picks,
      pick_of_the_week: llmResult.pick_of_the_week,
      full_summary: llmResult.full_summary,
      sources_status: sourcesStatus,
    };

    await db.doc(`digests/${weekId}`).set(digest);

    logger.info(`summarizeDigest complete for ${weekId}: ${digest.top_picks.length} top_picks`);
    res.status(200).json({ week_id: weekId, top_picks_count: digest.top_picks.length });
  }
);
