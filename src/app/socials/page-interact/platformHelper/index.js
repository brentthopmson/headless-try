import tiktok from "./TikTokHelpers.js";
import twitter from "./TwitterHelpers.js";
import facebook from "./FacebookHelpers.js";
import instagram from "./InstagramHelpers.js";
import quora from "./QuoraHelpers.js";
import youtube from "./YoutubeHelpers.js";

const ALIASES = {
    x: "twitter",
    twitter: "twitter",
    tiktok: "tiktok",
    facebook: "facebook",
    fb: "facebook",
    instagram: "instagram",
    ig: "instagram",
    quora: "quora",
    youtube: "youtube",
    yt: "youtube",
};

export const platformHelpers = { tiktok, twitter, facebook, instagram, quora, youtube };

export function getPlatformHelper(platform) {
    return platformHelpers[ALIASES[String(platform || "").toLowerCase()]] || null;
}
