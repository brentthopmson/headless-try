// Static, general-purpose defaults for campaign context/prompt fields.
// These are intentionally NOT AI-generated: they are safe, editable text shown
// by default so a campaign works even if the operator configures nothing.
// Keep in sync with the frontend copy in app/constants/campaignDefaults.ts.

export const DEFAULT_ENRICHMENT_CONTEXT = [
  'Use only verifiable public signals (company website/about/contact/team pages,',
  'public profiles, directories, and domain/company intel). Confirm identity',
  '(person <-> company/domain) before writing fields. Fill/correct FIRSTNAME/LASTNAME,',
  'BUSINESSNAME, JOBTITLE, BUSINESSPHONE/PHONE, URL, and a short factual CONTEXT',
  '(who they are, what the business does, relevant role/location). If a value cannot',
  'be verified, leave it blank or mark no_data rather than guessing. Do not invent',
  'emails, phones, URLs, employers, titles, or locations.',
].join(' ');

export const DEFAULT_PERSONALIZATION_PROMPT = [
  'You are writing cold outreach on behalf of the sender (our campaign), not as the',
  'recipient. Write a unique, natural, professional email per recipient using their',
  'available row fields and verified enriched data (name, company, role/title, website,',
  'location, and CONTEXT). Be specific and relevant; avoid generic templates, flattery,',
  'placeholders, unsupported claims, and invented facts. Keep it concise with a clear',
  'CTA. Never output placeholder signatures such as [Your Name], [your name], or',
  '{{tokens}}; if no sender name is provided, end with a natural sign-off and no name',
  'line.',
].join(' ');

export const DEFAULT_EMAIL_STRATEGY_PROMPT = [
  'You are replying on behalf of our campaign/sender account to a contact who responded',
  'to our outreach. Be helpful, professional, concise, and human. Match the intent:',
  'positive -> acknowledge and propose a clear next step; questions -> answer briefly;',
  'negative -> acknowledge and close politely; unsubscribe -> confirm and do not pitch;',
  'out-of-office -> no reply needed. Use campaign details only when accurate; never',
  'invent commitments, meetings, pricing, or facts.',
].join(' ');

export const DEFAULT_SOCIAL_STRATEGY_PROMPT = [
  'Write a short, friendly, non-spammy first DM as the sender. Reference one specific',
  'detail from the recipient profile or row data when available; keep it conversational,',
  'under 100 words, and never invent claims or relationships.',
].join(' ');
