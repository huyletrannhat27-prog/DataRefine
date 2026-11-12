
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDatasetFiles } from './dataset-files.mjs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { seedState } from './engine.mjs';

const externalOrigin = process.env.RENDER_EXTERNAL_URL
  ? new URL(process.env.RENDER_EXTERNAL_URL).origin
  : null;
const port = Number(process.env.PORT || process.env.DATAREFINE_PORT || 4318);
const hostname = externalOrigin ? '0.0.0.0' : '127.0.0.1';
const configuredAdmin = process.env.DATAREFINE_ADMIN;
if (externalOrigin && !configuredAdmin?.trim()) {
  throw new Error('Set DATAREFINE_ADMIN in the Render environment before starting DataRefine.');
}
const secret = configuredAdmin || randomBytes(12).toString('hex');

const stateDir = resolve(process.env.DATAREFINE_STATE_DIR ?? fileURLToPath(new URL('./.datarefine/', import.meta.url)));
mkdirSync(stateDir, {recursive:true});
function createLocalState() {
  const stateFile = join(stateDir,'state.json');
  let state;
  try { state = readFileSync(stateFile,'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = JSON.stringify(seedState());
  }
  let revision = 0;
  return {
    read() { return {state:JSON.parse(state), revision}; },
    write(serialized, expected) {
      if (revision !== expected) return false;
      const pending = stateFile + '.tmp';
      writeFileSync(pending,serialized,'utf8');
      renameSync(pending,stateFile);
      state = serialized;
      revision++;
      return true;
    }
  };
}

const asset = (file, type) => ({body:readFileSync(new URL('./public/' + file,import.meta.url),'utf8'), type:type + '; charset=utf-8'});
const index = asset('index.html','text/html');
const assets = { '/':index, '/admin':index, '/ui.js':asset('ui.js','text/javascript'), '/style.css':asset('style.css','text/css') };
const databaseUrl = process.env.DATABASE_URL?.trim();
let storage, blobs;
if (databaseUrl) {
  const { openPostgres, createPostgresState, createPostgresFiles } = await import('./postgres.mjs');
  storage = await createPostgresState(openPostgres(databaseUrl), seedState());
  blobs = createPostgresFiles(openPostgres(databaseUrl, 8));
} else storage = createLocalState();
const app = createApp(storage, assets, secret, createDatasetFiles(stateDir, { databaseUrl, blobs }));
// Large uploads can take more than the default five minutes; idle sockets still expire.
const server = createServer({ requestTimeout:0 }, async (req, res) => {
  try {
    // Render terminates TLS before forwarding the request; use its configured public origin.
    const base = externalOrigin ?? ('http://127.0.0.1:' + server.address().port);
    const url = new URL(req.url,base);
    if (url.origin !== base) { res.writeHead(400).end(); return; }
    const request = new Request(url, {
      method:req.method, headers:req.headers,
      ...(['GET','HEAD'].includes(req.method) ? {} : {body:Readable.toWeb(req,{ strategy:{ highWaterMark:256 * 1024, size:chunk => chunk.byteLength } }), duplex:'half'})
    });
    const response = await app(request);
    const headers = Object.fromEntries(response.headers);
    if (response.headers.has('set-cookie')) headers['set-cookie'] = response.headers.getSetCookie();
    res.writeHead(response.status,headers);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET') return;
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  }
});
server.setTimeout(120_000, socket => socket.destroy());
server.listen(port,hostname,() => {
  console.log('DataRefine: ' + (externalOrigin ?? ('http://127.0.0.1:' + server.address().port)));
  console.log('DataRefine storage: ' + (databaseUrl ? 'PostgreSQL' : 'local files'));
  if (!configuredAdmin) console.log('Ma quan tri (admin): ' + secret);
});
