const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export function corsJson(data, status = 200) {
    return Response.json(data, { status, headers: CORS_HEADERS });
}

export function corsOptions() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}
