import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const ENGINE_LOG = path.join(process.cwd(), 'engine.log');

export async function GET(request) {
    const url = new URL(request.url);
    const lines = parseInt(url.searchParams.get('lines') || '100', 10);
    const campaignId = url.searchParams.get('campaignId');

    try {
        let targetFile;
        let source;

        if (campaignId) {
            targetFile = path.join(LOGS_DIR, `campaign-${campaignId}.log`);
            source = 'campaign';
        } else {
            targetFile = ENGINE_LOG;
            source = 'engine';
        }

        if (!fs.existsSync(targetFile)) {
            return new Response(JSON.stringify({
                logs: [],
                source,
                error: fs.existsSync(LOGS_DIR)
                    ? `Log file not found: ${path.basename(targetFile)}`
                    : 'No log files found. Engine may not have written any logs yet.',
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        }

        const content = fs.readFileSync(targetFile, 'utf-8');
        const allLines = content.split('\n').filter(l => l.trim());
        const lastLines = allLines.slice(-lines);

        return new Response(JSON.stringify({ logs: lastLines, total: allLines.length, source }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
}
