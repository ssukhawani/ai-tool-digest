import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: "asia-southeast1" });

export { collectSources } from "./collectSources";
export { summarizeDigest } from "./summarizeDigest";
export { sendDigest } from "./sendDigest";
