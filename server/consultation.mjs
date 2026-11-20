import { createServer } from 'node:http';

const origin = 'https://auronixlab.com';
const webhook = new URL(process.env.MAKE_CONSULTATION_WEBHOOK);
if (webhook.protocol !== 'https:' || !/^hook\.[a-z0-9]+\.make\.com$/.test(webhook.hostname)) {
    throw new Error('Configure an HTTPS Make webhook URL.');
}
const key = process.env.MAKE_CONSULTATION_KEY;
if (!key) throw new Error('Configure the Make webhook API key.');

const limits = { Client_Name: 120, Client_Email: 254, Service_Requested: 100, Project_Details: 3000 };
const maxBody = 16384;
const windowMs = 600000;
const requests = new Map();
const clean = setInterval(() => {
    for (const [address, entry] of requests) {
        if (entry.until <= Date.now()) requests.delete(address);
    }
}, 60000);
clean.unref();

createServer(async (req, res) => {
    const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.url !== '/consultation') return send(404, { error: 'Not found' });
    if (req.headers.origin !== origin) return send(403, { error: 'Origin not allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return send(200, {});
    }
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return send(415, { error: 'Expected JSON' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || req.socket.remoteAddress;
    let entry = requests.get(ip);
    if (!entry || entry.until <= Date.now()) {
        if (!entry && requests.size >= 10000) return send(429, { error: 'Try again later' });
        entry = { count: 0, until: Date.now() + windowMs };
        requests.set(ip, entry);
    }
    if (++entry.count > 5) return send(429, { error: 'Try again later' });

    let body = '';
    let bytes = 0;
    let lead;
    const decoder = new TextDecoder();
    try {
        for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > maxBody) return send(413, { error: 'Request too large' });
            body += decoder.decode(chunk, { stream: true });
        }
        body += decoder.decode();
        lead = JSON.parse(body);
    } catch {
        return send(400, { error: 'Invalid request' });
    }
    const form = new FormData();
    for (const [field, limit] of Object.entries(limits)) {
        const value = typeof lead?.[field] === 'string' ? lead[field].trim() : '';
        if (!value || value.length > limit) return send(400, { error: 'Invalid form fields' });
        form.set(field, value);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.get('Client_Email'))) {
        return send(400, { error: 'Invalid email address' });
    }
    try {
        const response = await fetch(webhook, {
            method: 'POST', body: form, headers: { 'x-make-apikey': key },
            signal: AbortSignal.timeout(12000), redirect: 'error'
        });
        if (response.ok && (await response.json())?.delivered === true) {
            return send(200, { delivered: true });
        }
    } catch {
        // Keep Make credentials and request data out of logs and browser responses.
    }
    return send(502, { error: 'Delivery could not be confirmed' });
}).listen(Number(process.env.PORT ?? 10000), '0.0.0.0');
