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
            closeModal: "button[aria-label='Close']",
            commentItem: "article[data-testid='tweet']",
            commentLikeButton: "button[aria-label*='like']",
            commentReplyButton: "button[aria-label*='reply']",
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

            generateReply: `You are an outsider X/Twitter user who found this tweet — you are NOT the tweet author and the tweet was NOT made for you. Based on the post content and comments, generate a natural, engaging reply addressed to the AUTHOR (not to commenters and not about yourself):
- Is 1-2 sentences
- Adds value to the conversation
- Matches the tone of the post
- Is authentic and conversational
- NO hashtags unless absolutely relevant
- NO @mentions unless responding to someone
- Never speak as the author, never thank anyone for following you, never talk about your own follower count unless the tweet is explicitly about that

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
            // Search page
            searchBox: "input[data-key-interaction='search_input'], input[data-e2e='search-user-input'], input[placeholder*='Search']",
            searchSubmit: "button[data-e2e='search-box-button'], button[data-e2e='nav-search']", // both carry .TUXButton-label "Search"
            searchResultsContainer: "#search_top-item-list, div[data-e2e='search_top-item-list']",
            searchResultItem: "div[data-e2e='search_top-item'], div[id^='grid-item-container-']",
            postLink: "a[href*='/photo/'], a[href*='/video/']",
            videoCaption: "div[data-e2e='search-card-video-caption'], span[data-e2e='search-card-video-desc'], [data-e2e='browse-desc']",
            videoAuthor: "a[data-e2e='search-card-user-link'], span[data-e2e='search-card-user-unique-id'], a[data-e2e='browse-username']",
            videoViews: "strong[data-e2e='video-views']",
            // Opened post overlay. browse-like-icon is the VISIBLE action-bar
            // heart on direct /photo/ pages (prefer it); HeartWrapper is the
            // modal like button (may be hidden/stale on photo posts).
            likeButton: "div[data-e2e='browse-like-icon'], span[class*='HeartWrapper'], [data-e2e='like-icon']",
            likeCount: "span[data-e2e='browse-like-count']",
            // Action-rail comment icon. Legacy data-e2e attrs first; fallback
            // = the tux icon-button SVG path signature of the comment bubble
            // ("M2 21.5c0-10.22 9.88-18..." — unique vs heart/bookmark/share).
            commentButton: "div[data-e2e='browse-comment-icon'], [data-e2e='comment-icon'], button[data-testid='tux-web-icon-button'] svg path[d*='9.88-18']",
            commentCount: "span[data-e2e='browse-comment-count']",
            // Comments tab (tabbar item labelled "Comments" — post pages open
            // on "You may like"; composer/list only render after this tab).
            commentsTab: "div[class*='tux-tabbar-item'] span[data-testid='tux-web-text']",
            browseUsername: "[data-e2e='browse-username']",
            browseDesc: "[data-e2e='browse-desc']",
            browseClose: "button[data-e2e='browse-close']",
            followButton: "[data-e2e='browse-follow']",
            // Comment list (live DOM: DivCommentObjectWrapper only — ItemWrapper
            // is nested inside it; matching both double-counts/double-extracts)
            commentContainer: "div[class*='DivCommentObjectWrapper']",
            commentItem: "div[class*='DivCommentObjectWrapper']",
            commentLevel1: "p[data-e2e='comment-level-1'], span[data-e2e='comment-level-1']",
            commentUsername: "[data-e2e^='comment-username-']",
            commentLikeButton: "div[data-key-interaction='comment_like'], [data-key-interaction='comment_like']",
            commentLikeCount: "span[data-e2e='comment-like-count']",
            commentReplyTrigger: "p[data-key-interaction='comment_reply']",
            commentReplyButton: "p[data-key-interaction='comment_reply'], p[aria-label='Reply'][data-e2e^='comment-reply-'], [data-e2e^='comment-reply-'], [aria-label='Reply']",
            viewMoreReplies: "p[data-e2e='view-more-1'], p[data-e2e^='view-more-']",
            // Comment composer (bottom bar — MAIN post comment)
            commentInputContainer: "div[data-e2e='comment-input']",
            // TUX v1_8_0: the editable contenteditable lives on a DESCENDANT
            // .public-DraftEditor-content, never on the comment-text /
            // comment_input containers themselves — targeting the container
            // silently no-ops typing. Main composer = data-e2e='comment-text'
            // (footer). The shared data-key-interaction='comment_input' also
            // matches INLINE REPLY editors — demoted to LAST fallback only.
            commentBox: "div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-text'][contenteditable='true'], div[data-e2e='comment-text'] .public-DraftEditor-content[contenteditable='true'], div[data-key-interaction='comment_input'] div[contenteditable='true']",
            // Main submit ONLY — button[data-e2e='comment-post']. The generic
            // data-key-interaction='comment_submit' also matches reply submits
            // (comment-reply-post) and document-order first-match could hit
            // the wrong one. Scoped lookup happens inside postCommentVerified.
            commentSubmit: "button[data-e2e='comment-post']",
            // Inline REPLY composer (inside a comment container when Reply clicked)
            commentReplyInputContainer: "div[data-e2e='comment-reply-input']",
            commentReplyBox: "div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']",
            commentReplySubmit: "button[data-e2e='comment-reply-post']",
            // TikTok TUX audio captcha (main page, not iframe)
            captchaContainer: "#captcha-verify-container-main-page",
            captchaClose: "#captcha_close_button",
            captchaSwitch: "#captcha_switch_button", // label "Image" ⇒ currently on audio; label "Audio" ⇒ on image
            captchaRefresh: "#captcha_refresh_button",
            captchaPlay: "button[aria-label='Play']",
            captchaAudio: "#captcha-verify-container-main-page audio",
            captchaInput: "#captcha-verify-container-main-page input[placeholder='Enter what you hear'], #captcha-verify-container-main-page input.TUXTextInputCore-input",
            captchaVerify: "#captcha-verify-container-main-page button .TUXButton-label"
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
                    // q= in the URL renders results even if header typing fails;
                    // domcontentloaded because TikTok rarely reaches networkidle0.
                    { action: "navigate", url: "${searchUrl}?q=${keyword}", waitUntil: "domcontentloaded" },
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

            generateComment: `You are an everyday TikTok viewer who found this post. The post author is someone else — the post was NOT made for you, and you are NOT the author. Write a NATURAL, AUTHENTIC TikTok comment that:
- Is 1-2 sentences maximum
- Matches the video's tone and vibe
- Engages genuinely with the content
- Uses casual, conversational language
- Can include 1-2 relevant emojis if natural
- Feels like a real person commenting, not a bot
- NO @mentions unless it adds real value
- NO generic phrases like "love this" or "so funny"
- Should prompt engagement (ask a question or share a relatable thought)
- "You" = the post author. Never speak as the author and never talk about hitting 1k / follow-for-follow unless the video is explicitly about that.

Video vibe: {videoAnalysis}
Comments context: {commentsContext}

YOUR COMMENT (only the comment text, no quotes, just the text):`,

            shouldLikeComment: `Should this comment be liked? Evaluate:
1. Is it genuinely engaging/funny/helpful?
2. Is it relevant to the video?
3. Is it constructive or adds value?
4. Is it spam, promotional, or low-quality?
Respond with ONLY: like or skip`,

            replyToComment: `You are the viewer who just commented on this video. A different viewer (not you, not the author) left this comment UNDER the author's post — it was NOT sent to you and was NOT made for you. Generate a NATURAL, SHORT peer-to-peer reply to that fellow viewer:
- 1 sentence maximum
- Conversational, like a real person responding
- Can include 1 emoji if natural
- NO hashtags, NO @mentions
- Adds to the conversation, not generic
- Never thank them for following YOU, never assume "followed" means they followed you, never propose a follow-for-follow pact / hitting 1k, never speak as the author
- "You" = the commenter; "I" = you, the replier

Video context: {videoAnalysis}
Original video comment you posted (as a fellow viewer): {yourComment}
Commenter you reply to (their comment was posted to the author's post, not to you): {commentText}

YOUR REPLY (only the reply text, no quotes):`
        },

        // ===== EXTRACTORS =====
        extractors: {
            videos: {
                selector: "div[data-e2e='search_top-item'], div[id^='grid-item-container-']",
                parseFunction: `(items) => {
                    const videos = [];
                    items.forEach((item, idx) => {
                        try {
                            const captionEl = item.querySelector("[data-e2e='search-card-video-caption'], [data-e2e='search-card-video-desc'], [data-e2e='video-desc'], [data-e2e='browse-desc']");
                            const authorEl = item.querySelector("[data-e2e='search-card-user-unique-id'], [data-e2e='search-card-user-link'], a[href*='/@']");
                            const linkEl = item.querySelector("a[href*='/photo/'], a[href*='/video/']");
                            const viewsEl = item.querySelector("[data-e2e='video-views']");

                            videos.push({
                                index: idx,
                                caption: captionEl ? captionEl.textContent.trim() : '',
                                author: authorEl ? authorEl.textContent.trim() : '',
                                url: linkEl ? linkEl.href : '',
                                views: viewsEl ? viewsEl.textContent.trim() : '',
                                liked: item.querySelector("[aria-pressed='true'], [data-e2e='like-icon'][class*='active']") !== null
                            });
                        } catch (e) {
                            console.error('Error extracting video:', e);
                        }
                    });
                    return videos;
                }`
            },

            comments: {
                // Live TikTok DOM (Oct 2026): item wrapper is DivCommentObjectWrapper
                // (inner DivCommentItemWrapper is NESTED inside it). Match ONLY
                // ObjectWrapper — matching both extracted every comment TWICE
                // (observed: 32 comments → 64, all locateByText misses).
                // Username is a div[data-e2e^='comment-username-N'], not a span.
                selector: "div[class*='DivCommentObjectWrapper']",
                parseFunction: `(items) => {
                    const comments = [];
                    items.forEach((item, idx) => {
                        try {
                            const textEl = item.querySelector("p[data-e2e='comment-level-1'], span[data-e2e='comment-level-1'], span[data-testid='comment-text']");
                            const userEl = item.querySelector("[data-e2e^='comment-username-']");
                            const likeCountEl = item.querySelector("span[data-e2e='comment-like-count']");
                            if (textEl) {
                                comments.push({
                                    index: idx,
                                    id: item.id || '',
                                    text: textEl.textContent.trim(),
                                    username: userEl ? userEl.textContent.trim() : '',
                                    likeCount: likeCountEl ? likeCountEl.textContent.trim() : ''
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
            commentItem: "div[data-testid='comment']",
            commentLikeButton: "button[aria-label*='Like']",
            commentReplyButton: "div[role='button']:has-text('Reply')",
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
            generateReply: "You are an outsider Facebook user who found this post — you are NOT the post/page author and the post was NOT made for you. Generate a friendly, genuine comment addressed to the AUTHOR. Keep it short and conversational. Never speak as the author, never thank anyone for following you, never talk about your own follower count unless the post is explicitly about that.\nPost: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "div[data-testid='post']",
                parseFunction: `(posts) => {
                    const items = [];
                    posts.forEach((p, idx) => {
                        try {
                            const textEl = p.querySelector("div[data-testid='post_message']");
                            const linkEl = p.querySelector("a[href*='/posts/'], a[href*='/permalink/'], a[href*='/story.php'], a[href*='groups/']");
                            const authorEl = p.querySelector("a[data-testid*='user'], a[href*='/profile.php'], span[dir='auto']");
                            const text = textEl ? textEl.textContent.trim().slice(0, 300) : '';
                            if (text || linkEl) items.push({ index: idx, text, caption: text, title: text, author: authorEl ? authorEl.textContent.trim() : 'unknown', url: linkEl ? linkEl.href : '' });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
            comments: {
                selector: "div[data-testid='comment']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const textEl = el.querySelector("div[data-testid='comment_message']");
                            const userEl = el.querySelector("a[href*='/profile']");
                            const text = textEl ? textEl.textContent.trim() : '';
                            if (text) out.push({ index: idx, text, username: userEl ? userEl.textContent.trim() : '' });
                        } catch(e) {}
                    });
                    return out;
                }`
            },
            // Per-comment like/reply targets (best-effort; waves skip when absent).
            commentItem: "div[data-testid='comment']",
            commentLike: "button[aria-label*='Like']",
            commentReply: "div[role='button']:has-text('Reply')",
        },

        // Per-comment selectors used by the generic runner's reply waves.
        // (selector keys live alongside `selectors` for adapter convenience)
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
            commentItem: "ul li div[role='button']",
            commentLikeButton: "button[aria-label*='Like']",
            commentReplyButton: "div[role='button']:has-text('Reply')",
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
            generateReply: "You are an outsider Instagram user who found this post — you are NOT the post author and the post was NOT made for you. Write a short, genuine comment about this post addressed to the AUTHOR. Be natural. Never speak as the author, never thank anyone for following you, never talk about your own follower count unless the post is explicitly about that.\nPost: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "article[role='presentation']",
                parseFunction: `(articles) => {
                    const items = [];
                    articles.forEach((a, idx) => {
                        try {
                            const capEl = a.querySelector("div[class*='caption']");
                            const linkEl = a.querySelector("a[href*='/p/'], a[href*='/reel/']");
                            const cap = capEl ? capEl.textContent.trim().slice(0, 200) : '';
                            if (cap || linkEl) items.push({ index: idx, caption: cap, title: cap, text: cap, author: 'unknown', url: linkEl ? linkEl.href : '' });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
            comments: {
                selector: "ul li div[role='button']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
                            if (text && !/Like|Reply/i.test(text)) out.push({ index: idx, text, username: '' });
                        } catch(e) {}
                    });
                    return out.slice(0, 20);
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
            likeButton: "button[aria-label*='Upvote']",
            upvoteButton: "button[aria-label*='Upvote']",
            commentButton: "button:has-text('Add comment'), button[aria-label*='comment' i]",
            commentBox: "div[contenteditable='true'][role='textbox']",
            commentSubmit: "button:has-text('Add comment')",
            followButton: "button:has-text('Follow')",
            // Per-comment waves (best-effort; skipped when absent).
            commentItem: "div[class*='qu-comment']",
            commentLikeButton: "button[aria-label*='Upvote']",
            commentReplyButton: "button:has-text('Reply')",
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
            generateReply: "You are an outsider Quora user who found this question/answer — you are NOT the question asker/author and it was NOT written for you. Write a helpful, genuine comment addressed to the CONTENT author (not to other commenters, not about yourself).\nContent: {postContent}\nComment:",
        },

        extractors: {
            posts: {
                selector: "div[class*='qu-post']",
                parseFunction: `(posts) => {
                    const items = [];
                    posts.forEach((p, idx) => {
                        try {
                            const titleEl = p.querySelector("a[class*='qu-title']");
                            const title = titleEl ? titleEl.textContent.trim().slice(0, 200) : '';
                            if (title) items.push({ index: idx, title, caption: title, text: title, author: 'unknown', url: titleEl.href || '' });
                        } catch(e) {}
                    });
                    return items;
                }`
            },
            comments: {
                selector: "div[class*='qu-comment']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
                            if (text) out.push({ index: idx, text, username: '' });
                        } catch(e) {}
                    });
                    return out.slice(0, 20);
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
            commentButton: "button:has-text('Add a comment')",
            commentBox: "ytd-comment-simple-box-renderer div[contenteditable='true']",
            commentSubmit: "ytd-comment-simple-box-renderer #submit-button button",
            closeButton: "button[aria-label='Close']",
            // Per-comment waves (best-effort).
            commentItem: "ytd-comment-thread-renderer",
            commentLikeButton: "ytd-comment-renderer #like-button button",
            commentReplyButton: "ytd-comment-renderer #reply-button",
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

            generateReply: `You are an outsider YouTube viewer who found this video — you are NOT the channel/author and the video was NOT made for you. Based on the video content and comments, generate a natural, engaging comment addressed to the AUTHOR that:
- Is 1-2 sentences
- Adds value to the conversation
- Sounds authentic and conversational
- NO hashtags unless absolutely relevant
- NO @mentions
- Never speak as the author, never thank anyone for following you, never talk about your own follower count unless the video is explicitly about that

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
            },
            comments: {
                selector: "ytd-comment-thread-renderer",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const textEl = el.querySelector("#content-text");
                            const authorEl = el.querySelector("#author-text");
                            const text = textEl ? textEl.textContent.trim() : '';
                            if (text) out.push({ index: idx, text: text.slice(0, 300), username: authorEl ? authorEl.textContent.trim() : '' });
                        } catch(e) {}
                    });
                    return out.slice(0, 20);
                }`
            },
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

    // ==================== REDDIT ====================
    // Reddit search-interact differs sharply: search = r/subreddit listings,
    // "like" = upvote, post = thread, comments = threaded replies, composer
    // posts markdown (no hashtags/mentions). Voice: upvoter/commenter is an
    // outsider joining someone else's thread — never the OP, never the poster.
    reddit: {
        platform: "reddit",
        homeUrl: "https://www.reddit.com",
        searchUrl: "https://www.reddit.com/search",
        profileUrl: "https://www.reddit.com/user",

        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: null,
            searchResult: "a[data-testid='post-content']",
            postItem: "article[data-testid='post-content']",
            likeButton: "button[aria-label*='upvote' i]",
            upvoteButton: "button[aria-label*='upvote' i]",
            commentButton: "button:has-text('Comment')",
            commentBox: "div[contenteditable='true'], textarea",
            commentSubmit: "button:has-text('Comment'), button:has-text('Post')",
            followButton: "button:has-text('Follow')",
            // Per-comment waves (best-effort).
            commentItem: "div[data-testid='comment']",
            commentLikeButton: "button[aria-label*='upvote' i]",
            commentReplyButton: "button:has-text('Reply')",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            postLoadDelay: 3000,
            scrollDelay: 2000,
            navigationTimeout: 20000
        },

        workflows: {
            search: {
                name: "Search Reddit threads",
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
                name: "Reddit engagement: open thread → upvote → comment",
                steps: [
                    { action: "clickPost", postIndex: "${postIndex}" },
                    { action: "pause", duration: 2500 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzePost", prompt: "Summarize this Reddit thread in 1-2 sentences. What is it about?", resultKey: "analyzedPost" },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "scroll", distance: 600 },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzeComments", prompt: "What are people saying in the Reddit thread comments? Summarize sentiment and main topics.", resultKey: "analyzedComments" },
                    { action: "aiGenerateReply", postContent: "${analyzedPost}", comments: "${analyzedComments}", prompt: "${platformConfig.aiPrompts.generateReply}", resultKey: "generatedReply" },
                    { action: "fillText", selector: "${selectors.commentBox}", value: "${generatedReply}" },
                    { action: "pause", duration: 1000 },
                    { action: "click", selector: "${selectors.commentSubmit}" },
                    { action: "pause", duration: 2000 }
                ]
            }
        },

        aiPrompts: {
            analyzePost: `Analyze this Reddit thread/post and provide:\n1. Main topic/theme\n2. Sentiment (positive/negative/neutral/mixed)\n3. Relevant keywords\nKeep response concise (2-3 sentences).`,
            analyzeComments: `Analyze these Reddit thread comments and provide:\n1. General sentiment from commenters\n2. Main topics discussed\n3. What would be an appropriate response\nKeep response concise.`,
            generateReply: `You are an outsider Reddit user who found this thread — you are NOT the original poster (OP) and the post was NOT made for you. Based on the post content and comments, generate a natural, on-topic Reddit comment addressed to the OP / community:
- Is 1-3 sentences (Reddit allows fuller sentences than TikTok)
- Adds value to the conversation, no hashtags, NO @mentions
- Never speak as the OP, never thank anyone for following you, never talk about your own follower count / hitting 1k / mutual follows
- Never write as if the post is inviting you personally

Post: {postContent}
Comments analysis: {comments}

Comment (ONLY the comment text, nothing else):`,
            shouldLikeComment: `Should this Reddit comment be upvoted? Consider:\n1. Is it relevant to the thread?\n2. Is it constructive/helpful?\n3. Is it spam or low quality?\nRespond with ONLY: yes or no`
        },

        extractors: {
            posts: {
                selector: "article[data-testid='post-content']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const linkEl = el.querySelector("a[data-testid='post-content']");
                            const titleEl = el.querySelector("h3, [data-testid='post-title']");
                            const authorEl = el.querySelector("a[href*='/user/']");
                            const url = linkEl ? linkEl.href : (el.querySelector("a[href*='/comments/']")?.href || '');
                            const title = titleEl ? titleEl.textContent.trim().slice(0, 300) : '';
                            if (url) out.push({ index: idx, title, caption: title, text: title, author: authorEl ? authorEl.textContent.trim() : 'unknown', url });
                        } catch(e) {}
                    });
                    return out;
                }`
            },
            comments: {
                selector: "div[data-testid='comment']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const textEl = el.querySelector("[data-testid='comment-content']");
                            const authorEl = el.querySelector("a[href*='/user/']");
                            const text = textEl ? textEl.textContent.trim() : '';
                            if (text) out.push({ index: idx, text: text.slice(0, 300), username: authorEl ? authorEl.textContent.trim() : '' });
                        } catch(e) {}
                    });
                    return out.slice(0, 20);
                }`
            },
        },

        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: true,
            maxCommentsPerPost: 1,
            likeComments: true,
            followUsers: false,
        }
    },

    // ==================== THREADS ====================
    // Threads (Meta) search-interact: post = thread, like = heart, comment =
    // threaded reply. Composer is a lightweight post composer (no hashtags
    // needed, max ~500 chars). Voice mirrors X: outsider → author.
    threads: {
        platform: "threads",
        homeUrl: "https://www.threads.net",
        searchUrl: "https://www.threads.net/search",
        profileUrl: "https://www.threads.net",

        selectors: {
            searchBox: "input[placeholder*='Search']",
            searchSubmit: null,
            postItem: "div[data-testid='post']",
            likeButton: "button[aria-label*='Like']",
            commentButton: "button[aria-label*='Reply'], button[aria-label*='comment' i]",
            commentBox: "div[contenteditable='true'][role='textbox'], textarea",
            commentSubmit: "button:has-text('Post'), button:has-text('Reply')",
            followButton: "button:has-text('Follow')",
            commentItem: "div[data-testid='thread-comment'], article",
            commentLikeButton: "button[aria-label*='Like']",
            commentReplyButton: "button[aria-label*='Reply']",
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            postLoadDelay: 3000,
            scrollDelay: 2000,
            navigationTimeout: 20000
        },

        workflows: {
            search: {
                name: "Search Threads posts",
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
                name: "Threads engagement: open thread → like → reply",
                steps: [
                    { action: "clickPost", postIndex: "${postIndex}" },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzePost", prompt: "Summarize this Threads post in 1-2 sentences. What is it about?", resultKey: "analyzedPost" },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "scroll", distance: 400 },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent" },
                    { action: "aiAnalyzeComments", prompt: "What are people saying in the Threads replies? Summarize sentiment and main topics.", resultKey: "analyzedComments" },
                    { action: "aiGenerateReply", postContent: "${analyzedPost}", comments: "${analyzedComments}", prompt: "${platformConfig.aiPrompts.generateReply}", resultKey: "generatedReply" },
                    { action: "fillText", selector: "${selectors.commentBox}", value: "${generatedReply}" },
                    { action: "pause", duration: 1000 },
                    { action: "click", selector: "${selectors.commentSubmit}" },
                    { action: "pause", duration: 2000 }
                ]
            }
        },

        aiPrompts: {
            analyzePost: `Analyze this Threads post and provide:\n1. Main topic/theme\n2. Sentiment (positive/negative/neutral)\n3. Relevant keywords\nKeep response concise (2-3 sentences).`,
            analyzeComments: `Analyze these Threads replies and provide:\n1. General sentiment from repliers\n2. Main topics discussed\n3. What would be an appropriate response\nKeep response concise.`,
            generateReply: `You are an outsider Threads user who found this post — you are NOT the post author and the post was NOT made for you. Generate a natural, engaging reply addressed to the AUTHOR:
- Is 1-2 sentences (Threads cap ~500 chars — stay well under)
- Adds value to the conversation, casual and conversational
- NO hashtags unless absolutely relevant, NO @mentions
- Never speak as the author, never thank anyone for following you, never talk about your own follower count / hitting 1k unless the post is explicitly about that

Post: {postContent}
Replies analysis: {comments}

Reply (ONLY the reply text, nothing else):`,
            shouldLikeComment: `Should this Threads reply be liked? Consider:\n1. Is it relevant to the post?\n2. Is it constructive/helpful?\n3. Is it spam or low quality?\nRespond with ONLY: yes or no`
        },

        extractors: {
            posts: {
                selector: "div[data-testid='post']",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const linkEl = el.querySelector("a[href*='/@'], a[href*='/post/']");
                            const textEl = el.querySelector("div[data-testid='post-text'], span");
                            const text = textEl ? textEl.textContent.trim().slice(0, 300) : '';
                            if (text) out.push({ index: idx, text, caption: text, title: text, author: linkEl ? linkEl.textContent.trim() : 'unknown', url: linkEl ? linkEl.href : '' });
                        } catch(e) {}
                    });
                    return out;
                }`
            },
            comments: {
                selector: "div[data-testid='thread-comment'], article",
                parseFunction: `(items) => {
                    const out = [];
                    items.forEach((el, idx) => {
                        try {
                            const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
                            if (text) out.push({ index: idx, text, username: '' });
                        } catch(e) {}
                    });
                    return out.slice(0, 20);
                }`
            },
        },

        interactionRules: {
            likeEveryPost: true,
            commentOnEveryPost: true,
            maxCommentsPerPost: 1,
            likeComments: true,
            followUsers: false,
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
