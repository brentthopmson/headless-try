// Single canonical CSV schema for campaign pipeline stages.
//
// The first 93 columns are EXACTLY the user's source file header order. Stages
// must not insert columns in the middle (the old per-stage STANDARD_88_COLUMNS
// inserted JOBTITLE and shifted every downstream index). Engine-owned columns
// are appended at the END, so existing files can be upgraded with ensureColumn()
// without moving data.

export const SOURCE_CSV_COLUMNS = [
  'SN',
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT', 'URL', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract', 'shouldSendMessage',
  '', '',
  'emailSubject', 'emailBody', 'socialMessage', 'replyTo',
  '', '', '',
  'validation', 'providerMXResult', 'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  'enrichmentStatus',
  '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp',
  '', 'personalizationStatus', 'executionStatus',
];

// Engine-owned columns appended after the source header. `LINK` is a baked
// per-recipient URL; `HELPERKEYWORD` is stamped for reply detection.
export const DELIVERY_COLUMNS = [
  'LINK', 'HELPERKEYWORD',
  'retryCount', 'lastSendMethod', 'lastSendStatus', 'lastSendError', 'lastAttemptAt',
  'sentStatus', 'sendResult', 'sendError', 'deliveryStatus',
];

export const CANONICAL_CSV_COLUMNS = [...SOURCE_CSV_COLUMNS, ...DELIVERY_COLUMNS];

export function resolveCsvHeaderIndex(headers, nameOrAliases) {
  const names = Array.isArray(nameOrAliases) ? nameOrAliases : [nameOrAliases];
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = new Set(names.map(key));
  for (let i = 0; i < headers.length; i++) {
    if (keys.has(key(headers[i]))) return i;
  }
  return -1;
}

export function ensureCsvColumns(headers, rows) {
  const missing = [];
  for (const col of CANONICAL_CSV_COLUMNS) {
    if (!col) continue;
    if (resolveCsvHeaderIndex(headers, col) === -1) missing.push(col);
  }
  if (!missing.length) return;
  for (const col of missing) {
    headers.push(col);
    for (let i = 0; i < rows.length; i++) rows[i][headers.length - 1] = '';
  }
}
