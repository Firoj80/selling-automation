/**
 * gui-server.js
 * Zero-dependency GUI server for the product selling configuration.
 * Serves the dashboard at http://localhost:3131
 *
 * Run: node gui-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { readDocument, saveDocument } = require('./src/content/config-documents');
const PORT = 3131;
const ROOT = __dirname;
const GUI_FILE = path.join(ROOT, 'gui', 'index.html');

function sendJson(res, data, status=200) { res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
function bodyJson(req) { return new Promise((ok,err)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{try{ok(JSON.parse(b))}catch(e){err(e)}}); req.on('error',err); }); }

const server = http.createServer(async (req,res) => {
  const url = req.url.split('?')[0];
  const method = req.method;
  if (method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  try {
    if (method==='GET' && (url==='/'||url==='/index.html')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(GUI_FILE,'utf8')); }
    const kind = { '/api/product': 'product', '/api/copy': 'copy', '/api/voice': 'voice' }[url];
    if (kind && method === 'GET') return sendJson(res, { ok: true, ...readDocument(ROOT, kind) });
    if (kind && method === 'POST') {
      const input = await bodyJson(req);
      const result = await saveDocument(ROOT, kind, kind === 'product' ? input : input.text, req.headers['if-match']);
      return sendJson(res, { ok: true, ...result, message: 'Saved and validated.' });
    }
    res.writeHead(404); res.end('Not found');
  } catch(err) { console.error('[GUI ERR]',err.message); sendJson(res,{ok:false,error:err.message},err.code === 'CAMPAIGN_LOCKED' ? 409 : 400); }
});

server.listen(PORT,'127.0.0.1',()=>{
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   🚀  Product Config GUI is running          ║');
  console.log('  ║                                              ║');
  console.log('  ║   Open in browser:                           ║');
  console.log(`  ║   http://localhost:${PORT}                    ║`);
  console.log('  ║                                              ║');
  console.log('  ║   Press Ctrl+C to stop                       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
