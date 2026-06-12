const { google } = require('googleapis');
require('dotenv').config();
const JSON5 = require('json5');

function generateAuthUrl() {
    const oauth2Json = process.env.GOOGLE_OAUTH2_JSON;
    if (!oauth2Json) {
        console.error('Error: GOOGLE_OAUTH2_JSON not found in .env');
        return;
    }

    try {
        const { web: credentials } = JSON5.parse(oauth2Json);
        const { client_id, client_secret, redirect_uris } = credentials;

        const oauth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris[0]
        );

        const scopes = [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file'
        ];

        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent' // Force new refresh token
        });

        console.log('\n--- Action Required: Re-authenticate Google API ---');
        console.log('To fix "invalid_grant" errors, please visit this URL to authorize the app:\n');
        console.log(url);
        console.log('\nAfter visiting, you will be redirected to localhost (which might fail if server is off).');
        console.log('Copy the "code=" parameter from the URL bar and paste it here so we can generate a new token.');
        console.log('-----------------------------------------------------\n');

    } catch (error) {
        console.error('Error generating URL:', error.message);
    }
}

generateAuthUrl();
