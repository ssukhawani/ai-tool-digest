import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { currentWeekId } from "./weekId";
import { Digest, DigestTopPick, Config } from "./types";

const appsScriptWebhookUrl = defineSecret("APPS_SCRIPT_WEBHOOK_URL");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPick(pick: DigestTopPick, isFeatured: boolean): string {
  const border = isFeatured ? "border: 2px solid #00FF7F;" : "border: 1px solid #333;";
  return `
    <div style="${border} border-radius: 8px; padding: 16px; margin-bottom: 12px; background: #111;">
      <div style="font-size: 12px; color: #00FF7F; text-transform: uppercase; margin-bottom: 4px;">
        ${escapeHtml(pick.category)} · ${escapeHtml(pick.source)} · score ${pick.score}
      </div>
      <a href="${pick.url}" style="font-size: 18px; font-weight: bold; color: #fff; text-decoration: none;">
        ${escapeHtml(pick.title)}
      </a>
      <p style="color: #ccc; margin-top: 8px;">${escapeHtml(pick.why_it_matters)}</p>
    </div>
  `;
}

function renderDigestHtml(digest: Digest): string {
  const sourceLine = (Object.entries(digest.sources_status) as [string, string][])
    .map(([name, status]) => `${name}: ${status === "ok" ? "OK" : "unavailable"}`)
    .join(" &nbsp;·&nbsp; ");

  return `
    <meta charset="utf-8">
    <div style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 0 auto; background: #000; color: #eee; padding: 24px;">
      <h1 style="color: #00FF7F;">AI Tool Digest — ${digest.week_id}</h1>
      <p style="color: #aaa; font-size: 13px;">${sourceLine}</p>

      <h2 style="color: #fff; margin-top: 24px;">Pick of the Week</h2>
      ${renderPick(digest.pick_of_the_week, true)}

      <h2 style="color: #fff; margin-top: 24px;">This Week's Signal</h2>
      <p style="color: #ccc; line-height: 1.5;">${escapeHtml(digest.full_summary)}</p>

      <h2 style="color: #fff; margin-top: 24px;">Top Picks</h2>
      ${digest.top_picks.map((p) => renderPick(p, false)).join("")}
    </div>
  `;
}

async function postWithRetry(url: string, payload: unknown, maxAttempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(`Apps Script webhook returned HTTP ${res.status}`);
      }
      return;
    } catch (err) {
      lastError = err;
      logger.warn(`sendDigest: attempt ${attempt}/${maxAttempts} failed`, err);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

export const sendDigest = onRequest(
  { secrets: [appsScriptWebhookUrl], timeoutSeconds: 120, memory: "256MiB" },
  async (req, res) => {
    const weekId = currentWeekId();

    const digestDoc = await db.doc(`digests/${weekId}`).get();
    if (!digestDoc.exists) {
      res.status(404).json({ error: `digests/${weekId} not found — run summarizeDigest first` });
      return;
    }
    const digest = digestDoc.data() as Digest;

    const configDoc = await db.doc("config/pipeline").get();
    const config = configDoc.data() as Config;
    const recipients = config.recipient_emails;

    const html = renderDigestHtml(digest);
    const subject = `AI Tool Digest — ${digest.week_id} — ${digest.pick_of_the_week.title}`;

    try {
      await postWithRetry(appsScriptWebhookUrl.value(), {
        to: recipients.join(","),
        subject,
        html,
      });

      await db.doc(`digests/${weekId}`).update({
        status: "sent",
        sent_at: Timestamp.now(),
      });

      logger.info(`sendDigest: email sent for ${weekId} to ${recipients.join(",")}`);
      res.status(200).json({ week_id: weekId, status: "sent" });
    } catch (err) {
      logger.error(`sendDigest: all attempts failed for ${weekId}`, err);
      await db.doc(`digests/${weekId}`).update({ status: "failed" });
      res.status(502).json({ week_id: weekId, status: "failed", error: String(err) });
    }
  }
);
