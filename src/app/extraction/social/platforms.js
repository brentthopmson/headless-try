export const platformConfigs = {
  twitter: {
    platform: "twitter",
    profileUrl: "https://x.com",
    followersUrl: "https://x.com/{username}/followers",

    extractors: {
      profile: {
        selector: "main",
        parseFunction: `(container) => {
          const data = { stats: {}, recentTweets: [] };
          try {
            const spans = document.querySelectorAll("a span");
            spans.forEach(s => {
              const text = s.textContent.trim();
              if (text.match(/^\\d+[KMB]?$/)) {
                const label = s.closest("a")?.getAttribute("href") || "";
                if (label.includes("followers")) data.stats.followers = text;
                else if (label.includes("following")) data.stats.following = text;
                else data.stats.posts = text;
              }
            });
            document.querySelectorAll("article[role='presentation']").forEach(art => {
              const textEl = art.querySelector("div[data-testid='tweetText']");
              const linkEl = art.querySelector("a[role='link'][href*='/status/']");
              if (textEl) data.recentTweets.push({
                text: textEl.textContent.trim().slice(0, 280),
                url: linkEl?.href || "",
              });
            });
            data.recentTweets = data.recentTweets.slice(0, 5);
          } catch(e) {}
          return data;
        }`
      },
      followers: {
        selector: "div[data-testid='UserCell']",
        parseFunction: `(cells) => {
          const users = [];
          cells.forEach(cell => {
            try {
              const nameEl = cell.querySelector("a[role=link]");
              const bioEl = cell.querySelector("div[data-testid='UserDescription']");
              if (nameEl) users.push({
                username: nameEl.textContent.trim(),
                bio: bioEl?.textContent?.trim() || "",
              });
            } catch(e) {}
          });
          return users;
        }`
      },
    },
  },

  tiktok: {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@{username}",

    extractors: {
      profile: {
        selector: "div[data-e2e='followers-count']",
        parseFunction: `(elements) => {
          const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
          return {
            stats: {
              followers: getText("div[data-e2e='followers-count'] strong"),
              following: getText("div[data-e2e='following-count'] strong"),
              likes: getText("div[data-e2e='likes-count'] strong"),
            },
            bio: getText("h2[data-e2e='user-bio']"),
            nickname: getText("h1[data-e2e='user-title']"),
          };
        }`
      },
      videos: {
        selector: "div[data-testid='video-item']",
        parseFunction: `(items) => {
          const vids = [];
          items.forEach(item => {
            try {
              const captionEl = item.querySelector("div[data-testid='video-caption']");
              const linkEl = item.querySelector("a");
              if (captionEl) vids.push({
                caption: captionEl.textContent.trim().slice(0, 200),
                url: linkEl?.href || "",
              });
            } catch(e) {}
          });
          return vids;
        }`
      },
    },
  },

  instagram: {
    platform: "instagram",
    profileUrl: "https://www.instagram.com/{username}",

    extractors: {
      profile: {
        selector: "header",
        parseFunction: `(header) => {
          try {
            const meta = document.querySelector("meta[name='description']");
            const text = meta?.content || "";
            const parts = text.split(", ");
            return {
              stats: {
                posts: parts[0] || "",
                followers: parts[1] || "",
                following: parts[2] || "",
              },
              bio: document.querySelector("span[class*='bio']")?.textContent?.trim() || "",
              name: document.querySelector("h2")?.textContent?.trim() || "",
            };
          } catch(e) { return {}; }
        }`
      },
    },
  },

  facebook: {
    platform: "facebook",
    profileUrl: "https://www.facebook.com/{username}",

    extractors: {
      profile: {
        selector: "div[role='main']",
        parseFunction: `(main) => {
          try {
            const nameEl = document.querySelector("h1");
            const bioEl = document.querySelector("[class*='bio']");
            return {
              name: nameEl?.textContent?.trim() || "",
              bio: bioEl?.textContent?.trim() || "",
            };
          } catch(e) { return {}; }
        }`
      },
    },
  },

  quora: {
    platform: "quora",
    profileUrl: "https://www.quora.com/profile/{username}",

    extractors: {
      profile: {
        selector: "div[class*='profile']",
        parseFunction: `(container) => {
          try {
            const nameEl = document.querySelector("h1[class*='name']");
            const bioEl = document.querySelector("div[class*='bio']");
            const stats = {};
            document.querySelectorAll("span[class*='stat']").forEach(s => {
              const label = s.previousElementSibling?.textContent?.trim()?.toLowerCase() || "";
              if (label.includes("answer")) stats.answers = s.textContent.trim();
              if (label.includes("question")) stats.questions = s.textContent.trim();
              if (label.includes("follower")) stats.followers = s.textContent.trim();
            });
            return {
              name: nameEl?.textContent?.trim() || "",
              bio: bioEl?.textContent?.trim() || "",
              stats,
            };
          } catch(e) { return {}; }
        }`
      },
      followers: {
        selector: "div[class*='follower']",
        parseFunction: `(items) => {
          const users = [];
          items.forEach(item => {
            try {
              const nameEl = item.querySelector("a[class*='name']");
              if (nameEl) users.push({ name: nameEl.textContent.trim() });
            } catch(e) {}
          });
          return users;
        }`
      },
    },
  },
};

export function getPlatformConfig(platform) {
  const config = platformConfigs[platform];
  if (!config) throw new Error(`Platform extractor not found: ${platform}`);
  return config;
}

export function getExtractor(platform, extractorName) {
  const config = getPlatformConfig(platform);
  return config.extractors[extractorName] || null;
}
