// ============================================================
//  ImóvelHunter Web — Servidor Principal
// ============================================================
const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── Banco de dados em JSON ───────────────────────────────────
const DB_FILE = process.env.DATA_FILE || './data.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      config: {
        cidade: 'Cabo Frio',
        precoMin: 0,
        precoMax: 2000,
        tipo: 'aluguel',
        intervaloMinutos: 30,
        whatsappToken: '',
        whatsappPhone: '',
        whatsappPhoneId: '',
        ativo: false
      },
      imoveis: [],
      favoritos: [],
      ignorados: [],
      lastScan: null,
      stats: { total: 0, proprietarios: 0, imobiliarias: 0 }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Classificação proprietário vs imobiliária ────────────────
const KEYWORDS_IMOB = [
  'creci','imobiliária','imobiliaria','imóveis','imoveis','corretor',
  'consultoria','empreendimentos','construtora','incorporadora',
  'realty','real estate','gestão','gestao','administração',
  'ltda','s.a.','eireli','me ','epp','vendas','equipe'
];
const KEYWORDS_DONO = [
  'próprio dono','proprio dono','direto com o dono','dono direto',
  'sem intermediários','sem intermediarios','proprietário','proprietario',
  'particular','vendo direto','alugo direto','aceito visita'
];

function classificar(titulo, descricao, anunciante) {
  const texto = `${titulo} ${descricao} ${anunciante}`.toLowerCase();
  let scoreImob = 0, scoreDono = 0;
  KEYWORDS_IMOB.forEach(k => { if (texto.includes(k)) scoreImob += 2; });
  KEYWORDS_DONO.forEach(k => { if (texto.includes(k)) scoreDono += 2; });
  if (/creci[\s\-]?\d+/i.test(texto)) scoreImob += 5;
  if (/\b(minha casa|meu apartamento|meu imóvel)\b/i.test(texto)) scoreDono += 3;
  if (scoreImob > scoreDono) return 'imobiliaria';
  if (scoreDono > 0) return 'proprietario';
  return 'indefinido';
}

// ── Fetch helper ─────────────────────────────────────────────
function fetchPage(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Connection': 'keep-alive'
      }
    };
    const req = lib.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchPage(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// ── Scraper OLX ──────────────────────────────────────────────
async function scrapeOLX(config) {
  const results = [];
  try {
    const tipo = config.tipo === 'aluguel' ? 'aluguel' : 'venda';
    const url  = `https://www.olx.com.br/imoveis/${tipo}/casas-e-apartamentos/estado-rj?q=${encodeURIComponent(config.cidade)}&pe=${config.precoMax}${config.precoMin > 0 ? `&ps=${config.precoMin}` : ''}`;
    const html = await fetchPage(url);
    if (!html) return results;

    // Tenta extrair JSON embutido
    const jsonMatch = html.match(/"listingProps":\s*(\[[\s\S]*?\])\s*,\s*"listingState"/);
    if (jsonMatch) {
      try {
        const listings = JSON.parse(jsonMatch[1]);
        listings.forEach(item => {
          if (!item.title) return;
          results.push({
            id: `olx-${item.listId || Math.random().toString(36).slice(2)}`,
            titulo: item.title,
            preco: item.priceValue ? `R$ ${parseInt(item.priceValue).toLocaleString('pt-BR')}` : 'Consulte',
            precoNum: parseInt(item.priceValue) || 0,
            link: item.url || '',
            imagem: item.images?.[0]?.cdnUrl || '',
            localizacao: item.location || config.cidade,
            anunciante: item.subject || '',
            classificacao: classificar(item.title, item.description || '', item.subject || ''),
            descricao: (item.description || '').slice(0, 200),
            site: 'OLX',
            foundAt: new Date().toISOString()
          });
        });
      } catch(e) {}
    }

    // Fallback regex
    if (results.length === 0) {
      const titles = [...html.matchAll(/"title":"([^"]{10,80})"/g)].map(m => m[1]);
      const prices = [...html.matchAll(/"priceValue":(\d+)/g)].map(m => parseInt(m[1]));
      const urls   = [...html.matchAll(/"url":"(https:\/\/www\.olx[^"]+)"/g)].map(m => m[1]);
      for (let i = 0; i < Math.min(titles.length, 20); i++) {
        results.push({
          id: `olx-fb-${i}-${Date.now()}`,
          titulo: titles[i],
          preco: prices[i] ? `R$ ${prices[i].toLocaleString('pt-BR')}` : 'Consulte',
          precoNum: prices[i] || 0,
          link: urls[i] || `https://www.olx.com.br/imoveis/${tipo}`,
          imagem: '',
          localizacao: config.cidade,
          anunciante: '',
          classificacao: classificar(titles[i], '', ''),
          descricao: '',
          site: 'OLX',
          foundAt: new Date().toISOString()
        });
      }
    }
  } catch(e) { console.error('OLX error:', e.message); }
  return results;
}

// ── Scraper Zap Imóveis ──────────────────────────────────────
async function scrapeZap(config) {
  const results = [];
  try {
    const tipo = config.tipo === 'aluguel' ? 'aluguel' : 'venda';
    const url  = `https://www.zapimoveis.com.br/${tipo}/imoveis/rj+${encodeURIComponent(config.cidade.toLowerCase().replace(/ /g,'-'))}/?precoate=${config.precoMax}`;
    const html = await fetchPage(url);
    if (!html) return results;

    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});\s*<\/script>/);
    if (match) {
      try {
        const state    = JSON.parse(match[1]);
        const listings = state?.results?.listings || state?.listing?.search?.result?.listings || [];
        listings.forEach((item, i) => {
          const l = item.listing || item;
          results.push({
            id: `zap-${l.id || i}`,
            titulo: l.title || 'Imóvel',
            preco: l.pricingInfos?.[0]?.price ? `R$ ${parseInt(l.pricingInfos[0].price).toLocaleString('pt-BR')}` : 'Consulte',
            precoNum: parseInt(l.pricingInfos?.[0]?.price || 0),
            link: `https://www.zapimoveis.com.br/imovel/${l.id}/`,
            imagem: l.medias?.[0]?.url || '',
            localizacao: l.address?.neighborhood || config.cidade,
            anunciante: l.advertiser?.name || '',
            classificacao: classificar(l.title || '', l.description || '', l.advertiser?.name || ''),
            descricao: (l.description || '').slice(0, 200),
            site: 'Zap Imóveis',
            foundAt: new Date().toISOString()
          });
        });
      } catch(e) {}
    }
  } catch(e) { console.error('Zap error:', e.message); }
  return results;
}

// ── WhatsApp ─────────────────────────────────────────────────
function sendWhatsApp(config, message) {
  if (!config.whatsappToken || !config.whatsappPhone || !config.whatsappPhoneId) return;
  const body = JSON.stringify({
    messaging_product: 'whatsapp', to: config.whatsappPhone,
    type: 'text', text: { body: message }
  });
  const options = {
    hostname: 'graph.facebook.com',
    path: `/v18.0/${config.whatsappPhoneId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const req = https.request(options);
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── Scan principal ───────────────────────────────────────────
let scanning = false;
let lastScanResult = { added: 0, total: 0 };

async function runScan() {
  if (scanning) return lastScanResult;
  scanning = true;
  console.log('🔍 Iniciando varredura...');

  const db = loadDB();
  const existingIds = new Set(db.imoveis.map(i => i.id));
  const ignorados   = new Set(db.ignorados);
  const novos = [];

  const [olx, zap] = await Promise.all([scrapeOLX(db.config), scrapeZap(db.config)]);
  const todos = [...olx, ...zap];

  for (const im of todos) {
    if (existingIds.has(im.id) || ignorados.has(im.id)) continue;
    if (im.precoNum > 0 && db.config.precoMax > 0 && im.precoNum > db.config.precoMax) continue;
    if (im.precoNum > 0 && db.config.precoMin > 0 && im.precoNum < db.config.precoMin) continue;
    novos.push(im);
    db.imoveis.unshift(im);
    existingIds.add(im.id);
  }

  db.imoveis    = db.imoveis.slice(0, 500);
  db.lastScan   = new Date().toISOString();
  db.stats      = {
    total:         db.imoveis.length,
    proprietarios: db.imoveis.filter(i => i.classificacao === 'proprietario').length,
    imobiliarias:  db.imoveis.filter(i => i.classificacao === 'imobiliaria').length
  };
  saveDB(db);

  // Alerta WhatsApp só para proprietários
  const props = novos.filter(i => i.classificacao === 'proprietario');
  for (const im of props.slice(0, 3)) {
    sendWhatsApp(db.config,
      `🏠 *PROPRIETÁRIO DIRETO!*\n\n📍 ${im.titulo}\n💰 ${im.preco}\n📌 ${im.localizacao}\n🌐 ${im.site}\n\n🔗 ${im.link}`
    );
  }

  lastScanResult = { added: novos.length, total: db.imoveis.length };
  scanning = false;
  console.log(`✅ Varredura concluída. +${novos.length} novos.`);
  return lastScanResult;
}

// ── Cron ─────────────────────────────────────────────────────
let cronJob = null;
function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  const db = loadDB();
  if (!db.config.ativo) return;
  const mins = db.config.intervaloMinutos || 30;
  cronJob = cron.schedule(`*/${mins} * * * *`, runScan);
  console.log(`⏰ Busca automática a cada ${mins} minutos`);
}
setupCron();

// ── API Routes ───────────────────────────────────────────────
app.get('/api/data',        (req, res) => res.json(loadDB()));
app.post('/api/config',     (req, res) => {
  const db = loadDB();
  db.config = { ...db.config, ...req.body };
  saveDB(db);
  setupCron();
  res.json({ ok: true });
});
app.post('/api/scan',       async (req, res) => {
  const result = await runScan();
  res.json(result);
});
app.post('/api/favorito',   (req, res) => {
  const db  = loadDB();
  const idx = db.favoritos.indexOf(req.body.id);
  if (idx === -1) db.favoritos.push(req.body.id);
  else db.favoritos.splice(idx, 1);
  saveDB(db);
  res.json({ favorito: idx === -1 });
});
app.post('/api/ignorar',    (req, res) => {
  const db = loadDB();
  if (!db.ignorados.includes(req.body.id)) db.ignorados.push(req.body.id);
  db.imoveis = db.imoveis.filter(i => i.id !== req.body.id);
  saveDB(db);
  res.json({ ok: true });
});
app.post('/api/limpar',     (req, res) => {
  const db = loadDB();
  db.imoveis = []; db.stats = { total:0, proprietarios:0, imobiliarias:0 };
  saveDB(db);
  res.json({ ok: true });
});
app.get('/api/scan/status', (req, res) => res.json({ scanning, ...lastScanResult }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 ImóvelHunter rodando em http://localhost:${PORT}`);
});
