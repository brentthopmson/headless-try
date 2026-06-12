const { google } = require('googleapis');
const fs = require('fs');
const JSON5 = require('json5');
require('dotenv').config();

const CODE = "4/0ASc3gC2ze9NXsXM8KdFfN9M3SnaUv6gtE1ngBStNOZqEg1rdZrAzzJzpeNs2gsPx25FHuQ";

async function exchange() {
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

        console.log('Exchanging code for token...');
        const { tokens } = await oauth2Client.getToken(CODE);
        console.log('Tokens received.');

        if (tokens.refresh_token) {
            console.log('New Refresh Token:', tokens.refresh_token);

            // Update .env file
            const envPath = '.env';
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                const regex = /^GOOGLE_DRIVE_REFRESH_TOKEN=.*$/m;

                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
                    console.log('Updated existing GOOGLE_DRIVE_REFRESH_TOKEN in .env');
                } else {
                    envContent += `\nGOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`;
                    console.log('Appended GOOGLE_DRIVE_REFRESH_TOKEN to .env');
                }

                fs.writeFileSync(envPath, envContent);
                console.log('SUCCESS: .env file updated automatically.');
            } else {
                console.error('.env file not found!');
            }

        } else {
            console.warn('No refresh token returned! (Did you use prompt=consent?)');
            console.log('Access Token:', tokens.access_token);
        }

    } catch (error) {
        console.error('Error exchanging token:', error.response ? error.response.data : error.message);
    }
}

exchange();
