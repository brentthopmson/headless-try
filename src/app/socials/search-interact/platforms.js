import logger from "../../../utils/logger.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";

// AI instance for content analysis & comment generation
const ai = new MultiProviderAI();

export const platformConfigs = {
    // ==================== TWITTER / X ====================
    twitter: {
        platform: "twitter",
        homeUrl: "https://x.com/home",
        searchUrl: "https://x.com/search",
        profileUrl: "https://x.com",
        
        selectors: {
            searchBox: "input[aria-label='Search post']",
            searchSubmit: "button:has-text('Search')",
            feedContainer: "main [role='region']",
            postItem: "article[role='presentation']",
            postText: "div[data-testid='tweetText']",
            postAuthor: "a[data-testid='User-Name']",
            postLink: "a[role='link'][href*='/status/']",
            likeButton: "button[aria-label*='like']",
            replyButton: "button[aria-label*='reply']",
            replyTextBox: "div[contenteditable='true'][role='textbox']",
            replySubmit: "button:has-text('Post')",
            closeModal: "button[aria-label='Close']"
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            postLoadDelay: 3000,
            scrollDelay: 1500,
            navigationTimeout: 15000
        },

        // ===== WORKFLOWS =====
        workflows: {
            search: {
                name: "Search for posts",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 1500 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "submitSearch" },
                    { action: "pause", duration: 3000 }
                ],
                extract: "posts"
            },

            interactWithPost: {
                name: "Interact with single post (like, reply, like comments)",
                steps: [
                    { action: "clickPost", postIndex: "${postIndex}" },
                    { action: "pause", duration: 2000 },
                    
                    // Analyze post content with AI
                    { action: "capturePageContent" },
                    { action: "aiAnalyzePost", prompt: "Summarize this post in 1-2 sentences. What is it about?", resultKey: "analyzedPost" },
                    
                    // Like the post
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                    
                    // Scroll to see replies
                    { action: "scroll", distance: 300 },
                    { action: "pause", duration: 2000 },
                    
                    // Get post replies/comments
                    { action: "capturePageContent" },
                    { action: "aiAnalyzeComments", prompt: "What are people saying in the comments? Summarize the sentiment and main topics.", resultKey: "analyzedComments" },
                    
                    // Generate and post a reply
                    { action: "aiGenerateReply", postContent: "${analyzedPost}", comments: "${analyzedComments}", prompt: "${platformConfig.aiPrompts.generateReply}", resultKey: "generatedReply" },
                    { action: "click", selector: "${selectors.replyButton}" },
                    { action: "pause", duration: 1000 },
                    { action: "fillText", selector: "${selectors.replyTextBox}", value: "${generatedReply}" },
                    { action: "click", selector: "${selectors.replySubmit}" },
                    { action: "pause", duration: 2000 },
                    
                    // Close modal and continue
                    { action: "click", selector: "${selectors.closeModal}" }
                ]
            }
        },

        // ===== AI PROMPTS =====
        aiPrompts: {
            analyzePost: `Analyze this Twitter post and provide:
1. Main topic/theme
2. Sentiment (positive/negative/neutral)
3. Engagement level indicators
4. Relevant keywords
Keep response concise (2-3 sentences).`,

            analyzeComments: `Analyze these comments and provide:
1. General sentiment from commenters
2. Main topics discussed
3. What would be an appropriate response
Keep response concise.`,

            generateReply: `Based on the post content and comments, generate a natural, engaging Twitter reply that:
- Is 1-2 sentences
- Adds value to the conversation
- Matches the tone of the post
- Is authentic and conversational
- NO hashtags unless absolutely relevant
- NO @mentions unless responding to someone

Post: {postContent}
Comments analysis: {comments}

Reply (ONLY the reply text, nothing else):`,

            shouldLikeComment: `Should this comment be liked? Consider:
1. Is it relevant to the post?
2. Is it constructive/helpful?
3. Is it spam or low quality?
Respond with ONLY: yes or no`
        },

        // ===== EXTRACTORS =====
        extractors: {
            posts: {
                selector: "article[role='presentation']",
                fields: {
                    text: "div[data-testid='tweetText']",
                    author: "a[data-testid='User-Name']",
                    link: "a[role='link'][href*='/status/']"
                },
                parseFunction: `(articles) => {
                    const posts = [];
                    articles.forEach((article, idx) => {
                        try {
                            const textEl = article.querySelector("div[data-testid='tweetText']");
                            const linkEl = article.querySelector("a[role='link'][href*='/status/']");
                            const authorEl = article.querySelector("a[data-testid='User-Name']");
                            
                            if (textEl && linkEl) {
                                posts.push({
                                    index: idx,
                                    text: textEl.textContent.trim(),
                                    author: authorEl?.textContent?.trim() || 'unknown',
                                    url: linkEl.href,
                                    liked: article.querySelector("button[aria-label*='Unlike']") !== null
                                });
                            }
                        } catch (e) {
                            console.error('Error extracting post:', e);
                        }
                    });
                    return posts;
                }`
            },

            comments: {
                selector: "article[data-testid='tweet']",
                parseFunction: `(articles) => {
                    const comments = [];
                    articles.forEach((article, idx) => {
                        try {
                            const textEl = article.querySelector("div[data-testid='tweetText']");
                            if (textEl) {
                                comments.push({
                                    index: idx,
                                    text: textEl.textContent.trim()
                                });
                            }
                        } catch (e) {
                            console.error('Error extracting comment:', e);
                        }
                    });
                    return comments;
                }`
            }
        },

        // ===== INTERACTION RULES =====
        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: true,
            maxCommentsPerPost: 1,
            likeComments: true,
            maxCommentsToLike: 3,
            followUsers: false,
            retweetPosts: false
        }
    },

    // ==================== TIKTOK ====================
    tiktok: {
        platform: "tiktok",
        homeUrl: "https://www.tiktok.com/foryou",
        searchUrl: "https://www.tiktok.com/search",
        profileUrl: "https://www.tiktok.com",
        
        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: "button[type='submit']",
            videoItem: "div[data-testid='video-item']",
            videoCaption: "div[data-testid='video-caption']",
            videoAuthor: "a[data-testid='user-link']",
            likeButton: "button[data-testid='like-button']",
            commentButton: "button[data-testid='comment-button']",
            commentBox: "div[contenteditable='true']",
            commentSubmit: "button:has-text('Send')",
            closeButton: "button[aria-label='Close']"
        },

        timing: {
            minDelayBetweenActions: 1500,
            maxDelayBetweenActions: 4000,
            videoLoadDelay: 2000,
            scrollDelay: 1200,
            navigationTimeout: 12000
        },

        // ===== WORKFLOWS =====
        // TikTok detailed flow: Search keyword → Find posts → Click into post → Like post → Go to comments → 
        // Like comments → Analyze video/image via AI → Generate intelligent comment → Post comment → Like other comments
        workflows: {
            search: {
                name: "Search for videos",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 1500 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "submitSearch" },
                    { action: "pause", duration: 2500 }
                ],
                extract: "videos"
            },

            interactWithVideo: {
                name: "Full TikTok engagement: search → click → like → comments → analyze → comment → like replies",
                steps: [
                    // Step 1: Click on video to open
                    { action: "clickVideo", videoIndex: "${videoIndex}" },
                    { action: "pause", duration: 2500 },
                    
                    // Step 2: Capture video info and analyze with AI
                    { action: "capturePageContent", captureName: "videoPage" },
                    { action: "aiAnalyzeVideo", captureName: "videoPage", prompt: "${platformConfig.aiPrompts.analyzeVideo}", resultKey: "analyzedVideo" },
                    { action: "pause", duration: 1000 },
                    
                    // Step 3: Like the video
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                    
                    // Step 4: Open comments section
                    { action: "click", selector: "${selectors.commentButton}" },
                    { action: "pause", duration: 2000 },
                    
                    // Step 5: Capture and analyze existing comments
                    { action: "capturePageContent", captureName: "commentsSection" },
                    { action: "aiAnalyzeComments", captureName: "commentsSection", prompt: "${platformConfig.aiPrompts.analyzeComments}", resultKey: "analyzedComments" },
                    { action: "pause", duration: 1000 },
                    
                    // Step 6: Like relevant comments (max 2-3)
                    { action: "likeRandomComments", maxCount: 2, aiEvaluation: "${analyzedComments}" },
                    { action: "pause", duration: 1500 },
                    
                    // Step 7: Generate intelligent comment using AI
                    { action: "aiGenerateComment", 
                        videoAnalysis: "${analyzedVideo}",
                        commentsContext: "${analyzedComments}",
                        prompt: "${platformConfig.aiPrompts.generateComment}",
                        resultKey: "generatedComment"
                    },
                    { action: "pause", duration: 1000 },
                    
                    // Step 8: Post the generated comment
                    { action: "fillText", selector: "${selectors.commentBox}", value: "${generatedComment}" },
                    { action: "click", selector: "${selectors.commentSubmit}" },
                    { action: "pause", duration: 2000 },
                    
                    // Step 9: Like a few more comments after posting
                    { action: "likeRandomComments", maxCount: 2 },
                    { action: "pause", duration: 1000 },
                    
                    // Step 10: Close and return to search results
                    { action: "click", selector: "${selectors.closeButton}" }
                ]
            }
        },

        // ===== AI PROMPTS =====
        aiPrompts: {
            analyzeVideo: `You are analyzing a TikTok video. Provide:
1. Main content description (what's happening?)
2. Tone/vibe (funny, educational, trendy, emotional, creative, etc.)
3. Target audience (who would enjoy this?)
4. Key elements (music, effects, message, trend reference?)
5. Engagement hooks (why would people comment/like?)
Keep to 2-3 sentences, be concise.`,

            analyzeComments: `Analyze these TikTok comments. Provide:
1. Overall sentiment (mostly positive, mixed, critical, supportive?)
2. Main topics people are discussing
3. Types of comments (jokes, questions, compliments, critics?)
4. Common themes or patterns
5. What would be a fitting, natural response?
Be concise, capture the vibe.`,

            generateComment: `Generate a NATURAL, AUTHENTIC TikTok comment that:
- Is 1-2 sentences maximum
- Matches the video's tone and vibe
- Engages genuinely with the content
- Uses casual, conversational language
- Can include 1-2 relevant emojis if natural
- Feels like a real person commenting, not a bot
- NO @mentions unless it adds real value
- NO generic phrases like "love this" or "so funny"
- Should prompt engagement (ask a question or share a relatable thought)

Video vibe: {videoAnalysis}
Comments context: {commentsContext}

YOUR COMMENT (only the comment text, no quotes, just the text):`,

            shouldLikeComment: `Should this comment be liked? Evaluate:
1. Is it genuinely engaging/funny/helpful?
2. Is it relevant to the video?
3. Is it constructive or adds value?
4. Is it spam, promotional, or low-quality?
Respond with ONLY: like or skip`
        },

        // ===== EXTRACTORS =====
        extractors: {
            videos: {
                selector: "div[data-testid='video-item']",
                parseFunction: `(items) => {
                    const videos = [];
                    items.forEach((item, idx) => {
                        try {
                            const captionEl = item.querySelector("div[data-testid='video-caption']");
                            const authorEl = item.querySelector("a[data-testid='user-link']");
                            
                            if (captionEl && authorEl) {
                                videos.push({
                                    index: idx,
                                    caption: captionEl.textContent.trim(),
                                    author: authorEl.textContent.trim(),
                                    liked: item.querySelector("button[data-testid='like-button'][aria-pressed='true']") !== null
                                });
                            }
                        } catch (e) {
                            console.error('Error extracting video:', e);
                        }
                    });
                    return videos;
                }`
            },

            comments: {
                selector: "div[data-testid='comment-item']",
                parseFunction: `(items) => {
                    const comments = [];
                    items.forEach((item, idx) => {
                        try {
                            const textEl = item.querySelector("span[data-testid='comment-text']");
                            if (textEl) {
                                comments.push({
                                    index: idx,
                                    text: textEl.textContent.trim()
                                });
                            }
                        } catch (e) {
                            console.error('Error extracting comment:', e);
                        }
                    });
                    return comments;
                }`
            }
        },

        // ===== INTERACTION RULES =====
        interactionRules: {
            likeEveryVideo: true,
            commentOnEveryVideo: true,
            maxCommentsPerVideo: 1,
            likeCommentsBeforePosting: true,
            maxCommentsToLikeBefore: 2,
            likeCommentsAfterPosting: true,
            maxCommentsToLikeAfter: 2,
            followUsers: false,
            shareVideos: false
        }
    },

    // ==================== FACEBOOK ====================
    facebook: {
        platform: "facebook",
        homeUrl: "https://www.facebook.com",
        searchUrl: "https://www.facebook.com/search",
        profileUrl: "https://www.facebook.com",

        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: "button[type='submit']",
            postItem: "div[data-testid='post']",
            postText: "div[data-testid='post_message']",
            likeButton: "button[aria-label*='Like']",
            commentButton: "button[aria-label*='Comment']",
            commentBox: "div[role='textbox']",
            commentSubmit: "button:has-text('Post')",
            shareButton: "button[aria-label*='Share']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            postLoadDelay: 3000,
            scrollDelay: 2000,
            navigationTimeout: 20000,
        },

        workflows: {
            search: {
                name: "Search Facebook posts",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "submitSearch" },
                    { action: "pause", duration: 3000 },
                ],
                extract: "posts"
            },
            interactWithPost: {
                name: "Like and comment on Facebook post",
                steps: [
                    { action: "clickPost", postIndex: 0 },
                    { action: "pause", duration: 2500 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzePost", prompt: "Summarize this Facebook post." },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        aiPrompts: {
            analyzePost: "Analyze this Facebook post. What's the main topic and sentiment?",
            generateReply: "Generate a friendly, genuine Facebook comment. Keep it short and conversational.\nPost: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "div[data-testid='post']",
                parseFunction: `(posts) => {
                    const items = [];
                    posts.forEach(p => {
                        try {
                            const textEl = p.querySelector("div[data-testid='post_message']");
                            if (textEl) items.push({ text: textEl.textContent.trim().slice(0, 300) });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
        },

        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: false,
            maxCommentsPerPost: 1,
        }
    },

    // ==================== INSTAGRAM ====================
    instagram: {
        platform: "instagram",
        homeUrl: "https://www.instagram.com",
        searchUrl: "https://www.instagram.com/explore/search",
        profileUrl: "https://www.instagram.com",

        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: null,
            postItem: "article[role='presentation']",
            postCaption: "div[class*='caption']",
            likeButton: "button[aria-label*='Like']",
            commentButton: "button[aria-label*='Comment']",
            commentBox: "textarea[aria-label*='Add a comment']",
            commentSubmit: "button:has-text('Post')",
            followButton: "button:has-text('Follow')",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            postLoadDelay: 3000,
            scrollDelay: 2500,
            navigationTimeout: 20000,
        },

        workflows: {
            search: {
                name: "Search Instagram",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "pause", duration: 2500 },
                ],
                extract: "posts"
            },
            interactWithPost: {
                name: "Like Instagram post",
                steps: [
                    { action: "clickPost", postIndex: 0 },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        aiPrompts: {
            analyzePost: "Analyze this Instagram post content. What's the vibe and topic?",
            generateReply: "Write a short, genuine Instagram comment about this post. Be natural.\nPost: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "article[role='presentation']",
                parseFunction: `(articles) => {
                    const items = [];
                    articles.forEach(a => {
                        try {
                            const capEl = a.querySelector("div[class*='caption']");
                            if (capEl) items.push({ caption: capEl.textContent.trim().slice(0, 200) });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
        },

        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: false,
            followUsers: false,
        }
    },

    // ==================== QUORA ====================
    quora: {
        platform: "quora",
        homeUrl: "https://www.quora.com",
        searchUrl: "https://www.quora.com/search",
        profileUrl: "https://www.quora.com",

        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: null,
            postItem: "div[class*='qu-post']",
            postTitle: "a[class*='qu-title']",
            postContent: "div[class*='qu-content']",
            upvoteButton: "button[aria-label*='Upvote']",
            commentBox: "div[contenteditable='true'][role='textbox']",
            commentSubmit: "button:has-text('Add comment')",
            followButton: "button:has-text('Follow')",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 5000,
            postLoadDelay: 3000,
            scrollDelay: 2000,
            navigationTimeout: 20000,
        },

        workflows: {
            search: {
                name: "Search Quora",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "pause", duration: 2500 },
                ],
                extract: "posts"
            },
            interactWithPost: {
                name: "Upvote and engage with Quora content",
                steps: [
                    { action: "clickPost", postIndex: 0 },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.upvoteButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        aiPrompts: {
            analyzePost: "Analyze this Quora question or answer. What is it about?",
            generateReply: "Write a helpful, genuine comment on this Quora content.\nContent: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "div[class*='qu-post']",
                parseFunction: `(posts) => {
                    const items = [];
                    posts.forEach(p => {
                        try {
                            const titleEl = p.querySelector("a[class*='qu-title']");
                            if (titleEl) items.push({ title: titleEl.textContent.trim().slice(0, 200) });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
        },

        interactionRules: {
            upvoteEveryPost: true,
            commentOnEveryPost: false,
            followUsers: false,
        }
    },

    // ==================== YOUTUBE ====================
    youtube: {
        platform: "youtube",
        homeUrl: "https://www.youtube.com",
        searchUrl: "https://www.youtube.com/results",
        profileUrl: "https://www.youtube.com",

        selectors: {
            searchBox: "input#search, input[name='search_query']",
            searchSubmit: null,
            videoItem: "ytd-video-renderer a#video-title",
            videoTitle: "a#video-title",
            videoAuthor: "ytd-channel-name a",
            likeButton: "#segmented-like-button button, #like-button button, button[aria-label^='like this video']",
            commentBox: "ytd-comment-simple-box-renderer div[contenteditable='true']",
            commentSubmit: "ytd-comment-simple-box-renderer #submit-button button",
            closeButton: "button[aria-label='Close']"
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            videoLoadDelay: 3000,
            scrollDelay: 1500,
            navigationTimeout: 20000
        },

        workflows: {
            search: {
                name: "Search YouTube videos",
                steps: [
                    { action: "navigate", url: "${searchUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 1500 },
                    { action: "fillSearch", selector: "${selectors.searchBox}", value: "${keyword}" },
                    { action: "submitSearch" },
                    { action: "pause", duration: 3000 }
                ],
                extract: "videos"
            },

            interactWithVideo: {
                name: "YouTube engagement: open video → like → comment",
                steps: [
                    { action: "clickVideo", videoIndex: "${videoIndex}" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzePost", prompt: "Summarize this YouTube video page (title and description) in 1-2 sentences. What is it about?", resultKey: "analyzedPost" },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "scroll", distance: 800 },
                    { action: "pause", duration: 2500 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzeComments", prompt: "What are people saying in the YouTube comments? Summarize the sentiment and main topics.", resultKey: "analyzedComments" },
                    { action: "aiGenerateReply", postContent: "${analyzedPost}", comments: "${analyzedComments}", prompt: "${platformConfig.aiPrompts.generateReply}", resultKey: "generatedReply" },
                    { action: "scroll", distance: 500 },
                    { action: "pause", duration: 2000 },
                    { action: "fillText", selector: "${selectors.commentBox}", value: "${generatedReply}" },
                    { action: "pause", duration: 1000 },
                    { action: "click", selector: "${selectors.commentSubmit}" },
                    { action: "pause", duration: 2500 }
                ]
            }
        },

        aiPrompts: {
            analyzePost: `Analyze this YouTube video page and provide:
1. Main topic/theme
2. Sentiment (positive/negative/neutral)
3. Relevant keywords
Keep response concise (2-3 sentences).`,

            analyzeComments: `Analyze these YouTube comments and provide:
1. General sentiment from commenters
2. Main topics discussed
3. What would be an appropriate response
Keep response concise.`,

            generateReply: `Based on the video content and comments, generate a natural, engaging YouTube comment that:
- Is 1-2 sentences
- Adds value to the conversation
- Sounds authentic and conversational
- NO hashtags unless absolutely relevant
- NO @mentions

Video: {postContent}
Comments analysis: {comments}

Comment (ONLY the comment text, nothing else):`,

            shouldLikeComment: `Should this comment be liked? Consider:
1. Is it relevant to the video?
2. Is it constructive/helpful?
3. Is it spam or low quality?
Respond with ONLY: yes or no`
        },

        extractors: {
            videos: {
                selector: "ytd-video-renderer",
                parseFunction: `(items) => {
                    const videos = [];
                    items.forEach((el, idx) => {
                        try {
                            const linkEl = el.querySelector("a#video-title");
                            const authorEl = el.querySelector("ytd-channel-name a");
                            if (linkEl) {
                                videos.push({
                                    index: idx,
                                    title: (linkEl.getAttribute('title') || linkEl.textContent || '').trim().slice(0, 300),
                                    author: authorEl ? authorEl.textContent.trim() : 'unknown',
                                    url: linkEl.href,
                                    liked: el.querySelector("button[aria-label^='remove this video from Liked']") !== null
                                });
                            }
                        } catch (e) {
                            console.error('Error extracting video:', e);
                        }
                    });
                    return videos;
                }`
            }
        },

        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: true,
            maxCommentsPerPost: 1,
            likeComments: false,
            followUsers: false,
            retweetPosts: false
        }
    },
};

/**
 * Get platform configuration
 */
export function getPlatformConfig(platform) {
    const config = platformConfigs[platform];
    if (!config) {
        throw new Error(`Platform config not found: ${platform}`);
    }
    return config;
}

/**
 * Get workflow definition for a platform and operation
 */
export function getWorkflow(platform, operation) {
    const platformConfig = getPlatformConfig(platform);
    if (!platformConfig.workflows) {
        throw new Error(`No workflows defined for platform: ${platform}`);
    }
    
    const workflow = platformConfig.workflows[operation];
    if (!workflow) {
        throw new Error(`No workflow '${operation}' defined for platform: ${platform}`);
    }
    
    return workflow;
}

/**
 * Get AI prompt for a platform and prompt type
 */
export function getAIPrompt(platform, promptType) {
    const platformConfig = getPlatformConfig(platform);
    if (!platformConfig.aiPrompts) {
        return null;
    }
    return platformConfig.aiPrompts[promptType] || null;
}

/**
 * Get extractor definition for a platform
 */
export function getExtractor(platform, extractorName) {
    const platformConfig = getPlatformConfig(platform);
    if (!platformConfig.extractors) {
        return null;
    }
    return platformConfig.extractors[extractorName] || null;
}

/**
 * Get interaction rules for a platform
 */
export function getInteractionRules(platform) {
    const platformConfig = getPlatformConfig(platform);
    if (!platformConfig.interactionRules) {
        return {};
    }
    return platformConfig.interactionRules;
}

/**
 * Get selectors for a platform
 */
export function getSelectors(platform) {
    const platformConfig = getPlatformConfig(platform);
    return platformConfig.selectors || {};
}

/**
 * Get timing config for a platform
 */
export function getTiming(platform) {
    const platformConfig = getPlatformConfig(platform);
    return platformConfig.timing || {};
}

export { ai as MultiProviderAI };
