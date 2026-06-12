import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'engine.log');

export async function GET(request) {
    const url = new URL(request.url);
    const lines = parseInt(url.searchParams.get('lines') || '100', 10);

    try {
        if (!fs.existsSync(LOG_FILE)) {
            return new Response(JSON.stringify({ logs: [], error: 'Log file not found. Engine may not have written any logs yet.' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        }

        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const allLines = content.split('\n').filter(l => l.trim());
        const lastLines = allLines.slice(-lines);

        return new Response(JSON.stringify({ logs: lastLines, total: allLines.length }), {
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
