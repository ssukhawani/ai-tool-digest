import { Timestamp } from "firebase-admin/firestore";

export type SourceName = "producthunt" | "hackernews" | "github";

export interface RawItem {
  source: SourceName;
  week_id: string;
  title: string;
  url: string;
  description: string;
  score: number;
  comments_count: number;
  tags: string[];
  fetched_at: Timestamp;
  raw: Record<string, unknown>;
}

export interface DigestTopPick {
  title: string;
  url: string;
  source: string;
  category: string;
  why_it_matters: string;
  score: number;
}

export interface Digest {
  week_id: string;
  generated_at: Timestamp;
  sent_at: Timestamp | null;
  status: "draft" | "sent" | "failed";
  top_picks: DigestTopPick[];
  pick_of_the_week: DigestTopPick;
  full_summary: string;
  sources_status: Record<SourceName, "ok" | "failed">;
}

export interface Config {
  keyword_filters: string[];
  recipient_emails: string[];
  min_score_thresholds: Record<SourceName, number>;
}
