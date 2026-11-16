/**
 * CLI helper for Agent A (Antigravity) to submit task planning or review verdict
 * back to DeepSeek Harness (D) via the local network broker (127.0.0.1:18765).
 */
import http from 'node:http';
import fs from 'node:fs';

const HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_AGY_COLLAB_PORT || 18765);

function parseArgs(argv) {
  const out = { id: '', verdict: '', content: '', file: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--id' || a === '-i') && argv[i + 1]) {
      out.id = argv[++i];
    } else if ((a === '--verdict' || a === '-v') && argv[i + 1]) {
      out.verdict = argv[++i];
    } else if ((a === '--content' || a === '-c') && argv[i + 1]) {
      out.content = argv[++i];
    } else if ((a === '--file' || a === '-f') && argv[i + 1]) {
      out.file = argv[++i];
    }
  }
  if (out.file && !out.content) {
    out.content = fs.readFileSync(out.file, 'utf8');
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.content) {
  console.error('Usage: node reply-request.mjs --id <requestId> --verdict <PLAN_READY|APPROVED|CHANGES_REQUESTED> --content "<text>" (or --file <path>)');
  process.exit(1);
}

const body = JSON.stringify({
  requestId: args.id,
  verdict: args.verdict || undefined,
  content: args.content,
});

const req = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: '/reply',
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    },
    timeout: 10_000,
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      console.log(`[agy-collab-reply] status=${res.statusCode} response=${text}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);

req.on('error', (err) => {
  console.error(`[agy-collab-reply] error: ${err.message}`);
  process.exit(1);
});

req.write(body);
req.end();
