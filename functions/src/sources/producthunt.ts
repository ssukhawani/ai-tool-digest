import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../admin";
import { Config, RawItem } from "../types";

const GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";

const QUERY = `
  query WeeklyPosts($postedAfter: DateTime!) {
    posts(postedAfter: $postedAfter, order: VOTES, first: 50) {
      edges {
        node {
          name
          tagline
          url
          votesCount
          commentsCount
          topics {
            edges {
              node {
                name
              }
            }
          }
        }
      }
    }
  }
`;

interface PhPost {
  name: string;
  tagline: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  topics: { edges: { node: { name: string } }[] };
}

interface PhResponse {
  data?: { posts: { edges: { node: PhPost }[] } };
  errors?: { message: string }[];
}

function weekStartIso(): string {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  return monday.toISOString();
}

export async function fetchProductHunt(weekId: string, config: Config, token: string): Promise<number> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { postedAfter: weekStartIso() },
    }),
  });

  const body = (await res.json()) as PhResponse;
  if (!res.ok || body.errors) {
    throw new Error(
      `Product Hunt fetch failed: HTTP ${res.status} — ${body.errors ? JSON.stringify(body.errors) : "unknown error"}`
    );
  }

  const posts = body.data?.posts.edges.map((e) => e.node) ?? [];
  const threshold = config.min_score_thresholds.producthunt;
  const matched = posts.filter((p) => p.votesCount >= threshold);

  const batch = db.batch();
  const collection = db.collection("raw_items");

  for (const post of matched) {
    const rawItem: RawItem = {
      source: "producthunt",
      week_id: weekId,
      title: post.name,
      url: post.url,
      description: post.tagline,
      score: post.votesCount,
      comments_count: post.commentsCount,
      tags: post.topics.edges.map((e) => e.node.name),
      fetched_at: Timestamp.now(),
      raw: post as unknown as Record<string, unknown>,
    };
    batch.set(collection.doc(), rawItem);
  }

  if (matched.length > 0) {
    await batch.commit();
  }

  logger.info(`producthunt: ${matched.length} items matched out of ${posts.length} fetched`);
  return matched.length;
}
