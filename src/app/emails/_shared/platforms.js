import logger from "../../../utils/logger.js";

// ==================== Email Platform Configs ====================
// Platform-specific selectors, URLs, and timing for browser-based email automation.
// Modeled after socials/send-message/platforms.js pattern.

export const emailPlatforms = {

  // ==================== GMAIL ====================
  gmail: {
    platform: "gmail",
    composeUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
    inboxUrl: "https://mail.google.com/mail/u/0/#inbox",
    labelsUrl: "https://mail.google.com/mail/u/0/#settings/labels",

    selectors: {
      // Compose
      toInput: "textarea[name='to'], div[aria-label*='To'] input, div[role='combobox'][name='to']",
      subjectInput: "input[name='subjectbox'], input[placeholder*='Subject'], input[aria-label*='Subject']",
      bodyInput: "div[role='textbox'][aria-label*='Body'], div[contenteditable='true'][role='textbox']",
      sendButton: "div[role='button'][aria-label*='Send'], td[aria-label*='Send'] div[role='button']",

      // Inbox / Search
      searchBox: "input[aria-label*='Search mail'], input[placeholder*='Search mail']",
      searchInput: "input[aria-label*='Search'], input[placeholder*='Search']",
      threadRow: "tr.zA",
      threadSubject: ".bog, .y6",
      threadSnippet: ".y6 span, .bqe",
      threadSender: ".yW span[email], .yW .zF",

      // Labels
      settingsGear: "div[gh='cm']",
      settingsMenu: "div[role='menuitem']:has-text('Settings')",
      labelsTab: "div[role='tab']:has-text('Labels')",
      createLabelBtn: "div[role='button']:has-text('Create new label')",
      labelNameInput: "input[aria-label*='label name'], input[aria-label*='New label name']",
      labelConfirmBtn: "div[role='button']:has-text('Create')",

      // Reply
      replyButton: "div[aria-label*='Reply'][role='button'], span[aria-label*='Reply'][role='button']",
      replyBodyInput: "div[role='textbox'][aria-label*='Message Body'], div.editable.LW-avf",
    },

    timing: {
      afterNavigate: 4000,
      afterFill: 1500,
      afterSearch: 3000,
      betweenSends: [30000, 60000],
    },
  },

  // ==================== OUTLOOK ====================
  outlook: {
    platform: "outlook",
    composeUrl: "https://outlook.live.com/mail/0/?actSwt=true&compose=1",
    inboxUrl: "https://outlook.live.com/mail/0/inbox",
    labelsUrl: "https://outlook.live.com/mail/0/?path=/categories",

    selectors: {
      // Compose
      toInput: "input[aria-label*='To'], div[aria-label*='To'] input",
      subjectInput: "input[aria-label*='Add a subject'], input[aria-label*='Subject']",
      bodyInput: "div[role='textbox'][aria-label*='Message'], div[role='textbox'][contenteditable='true']",
      sendButton: "button[aria-label='Send']",

      // Inbox / Search
      searchBox: "input[placeholder*='Search'], input[aria-label*='Search']",
      searchInput: "input[placeholder*='Search current mailbox']",
      threadRow: "div[role='option']",
      threadSubject: "div[role='option'] span[class*='fontWeight']",
      threadSnippet: "div[role='option'] span[class*='lineClamp']",
      threadSender: "div[role='option'] div[title]",

      // Categories (Outlook's equivalent of labels)
      categoriesTab: "div[role='tab']:has-text('Categories')",
      newCategoryBtn: "button:has-text('New category')",
      categoryNameInput: "input[aria-label*='Name']",
      categorySaveBtn: "button:has-text('Save')",

      // Reply
      replyButton: "button[aria-label='Reply'], button[title='Reply']",
      replyBodyInput: "div[role='textbox'][aria-label*='Message'], div[role='textbox'][contenteditable='true']",
    },

    timing: {
      afterNavigate: 5000,
      afterFill: 2000,
      afterSearch: 3500,
      betweenSends: [30000, 60000],
    },
  },

  // ==================== YAHOO ====================
  yahoo: {
    platform: "yahoo",
    composeUrl: "https://mail.yahoo.com/d/compose",
    inboxUrl: "https://mail.yahoo.com/d/folders/1",
    labelsUrl: "https://mail.yahoo.com/d/settings/folders",

    selectors: {
      // Compose
      toInput: "input[aria-label*='To'], input#to-field",
      subjectInput: "input[aria-label*='Subject'], input#subject-field",
      bodyInput: "div[role='textbox'][aria-label*='Message body'], div[contenteditable='true']",
      sendButton: "button[data-test-id='compose-send-button'], button[title='Send']",

      // Inbox / Search
      searchBox: "input[placeholder*='Search'], input#search-input",
      searchInput: "input[placeholder*='Search all messages']",
      threadRow: "li[data-test='message-row']",
      threadSubject: "[data-test-id='subject']",
      threadSnippet: "[data-test-id='message-subtitle']",
      threadSender: "[data-test-id='sender']",

      // Folders (Yahoo's equivalent of labels)
      foldersTab: "div[data-test-id='folders-tab']",
      addFolderBtn: "button:has-text('Add folder')",
      folderNameInput: "input[aria-label*='Folder name']",
      folderSaveBtn: "button:has-text('Save')",

      // Reply
      replyButton: "button[title='Reply'], button[aria-label='Reply']",
      replyBodyInput: "div[role='textbox'][contenteditable='true']",
    },

    timing: {
      afterNavigate: 4000,
      afterFill: 1500,
      afterSearch: 3000,
      betweenSends: [30000, 60000],
    },
  },

  // ==================== AOL ====================
  aol: {
    platform: "aol",
    composeUrl: "https://mail.aol.com/d/compose",
    inboxUrl: "https://mail.aol.com/d/folders/1",
    labelsUrl: "https://mail.aol.com/d/settings/folders",

    selectors: {
      // Compose
      toInput: "input[aria-label*='To'], input#to-field",
      subjectInput: "input[aria-label*='Subject'], input#subject-field",
      bodyInput: "div[role='textbox'][aria-label*='Message body'], div[contenteditable='true']",
      sendButton: "button[data-test-id='compose-send-button']",

      // Inbox / Search
      searchBox: "input[placeholder*='Search']",
      searchInput: "input[placeholder*='Search all messages']",
      threadRow: "li[data-test='message-row']",
      threadSubject: "[data-test-id='subject']",
      threadSnippet: "[data-test-id='message-subtitle']",
      threadSender: "[data-test-id='sender']",

      // Folders
      foldersTab: "div[data-test-id='folders-tab']",
      addFolderBtn: "button:has-text('Add folder')",
      folderNameInput: "input[aria-label*='Folder name']",
      folderSaveBtn: "button:has-text('Save')",

      // Reply
      replyButton: "button[title='Reply'], button[aria-label='Reply']",
      replyBodyInput: "div[role='textbox'][contenteditable='true']",
    },

    timing: {
      afterNavigate: 4000,
      afterFill: 1500,
      afterSearch: 3000,
      betweenSends: [30000, 60000],
    },
  },
};

// ==================== Helpers ====================

/**
 * Detect email provider from email address or domain.
 * @param {string} email
 * @returns {string} platform key (gmail, outlook, yahoo, aol)
 */
export function detectEmailPlatform(email) {
  const domain = (email || "").split("@")[1]?.toLowerCase() || "";
  if (domain.includes("gmail") || domain.includes("googlemail")) return "gmail";
  if (domain.includes("outlook") || domain.includes("hotmail") || domain.includes("live")) return "outlook";
  if (domain.includes("yahoo")) return "yahoo";
  if (domain.includes("aol")) return "aol";
  return "gmail"; // default fallback
}

/**
 * Get platform config by key.
 * @param {string} platform - gmail, outlook, yahoo, aol
 * @returns {object} platform config
 */
export function getPlatformConfig(platform) {
  const key = (platform || "gmail").toLowerCase();
  return emailPlatforms[key] || emailPlatforms.gmail;
}

export { emailPlatforms as default };
