import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { db } from "./admin";
import { currentWeekId } from "./weekId";
import { fetchHackerNews } from "./sources/hackernews";
import { fetchProductHunt } from "./sources/producthunt";
import { fetchGitHubTrending } from "./sources/github";
import { Config, SourceName } from "./types";

const phDeveloperToken = defineSecret("PH_DEVELOPER_TOKEN");

export const collectSources = onRequest(
  { secrets: [phDeveloperToken], timeoutSeconds: 300, memory: "512MiB" },
  async (req, res) => {
    const weekId = currentWeekId();
    const configDoc = await db.doc("config/pipeline").get();
    if (!configDoc.exists) {
      res.status(500).json({ error: "config/pipeline document not found" });
      return;
    }
    const config = configDoc.data() as Config;

    const results = await Promise.allSettled([
      fetchHackerNews(weekId, config),
      fetchProductHunt(weekId, config, phDeveloperToken.value()),
      fetchGitHubTrending(weekId, config),
    ]);

    const sourceNames: SourceName[] = ["hackernews", "producthunt", "github"];
    const sourcesStatus: Record<SourceName, "ok" | "failed"> = {
      hackernews: "failed",
      producthunt: "failed",
      github: "failed",
    };
    const counts: Record<string, number> = {};

    results.forEach((result, i) => {
      const name = sourceNames[i];
      if (result.status === "fulfilled") {
        sourcesStatus[name] = "ok";
        counts[name] = result.value;
      } else {
        logger.error(`${name} fetch failed`, result.reason);
        counts[name] = 0;
      }
    });

    await db.doc(`raw_items_status/${weekId}`).set({
      week_id: weekId,
      sources_status: sourcesStatus,
      counts,
      collected_at: new Date(),
    });

    logger.info(
      `collectSources complete for ${weekId}: ` +
        sourceNames.map((n) => `${n}=${counts[n]}(${sourcesStatus[n]})`).join(", ")
    );

    res.status(200).json({ week_id: weekId, sources_status: sourcesStatus, counts });
  }
);
