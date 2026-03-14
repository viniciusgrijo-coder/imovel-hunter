 // ============================================================
//  ImóvelHunter Web — Servidor com API Mercado Livre (oficial)
// ============================================================
const express = require('express');
const https   = require('https');
const fs      = require('fs');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── Banco de dados ───────────────────────────────────────────
const DB_FILE = './data.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      config: {
        cidade: 'Cabo Frio',
        estado: 'RJ',
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
    }, null, 2));
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
  'realty','ltda','s.a.','eireli','administração','administracao'
];
const KEYWORDS_DONO = [
  'próprio dono','proprio dono','direto com o dono','dono direto',
  'sem intermediários','sem intermediarios','proprietário','proprietario',
  'particular','vendo direto','alugo direto'
];

function classificar(titulo, extra, vendedor) {
  const texto = `${titulo} ${extra} ${vendedor}`.toLowerCase();
  let si = 0, sd = 0;
  KEYWORDS_IMOB.forEach(k => { if (texto.includes(k)) si += 2; });
  KEYWORDS_DONO.forEach(k => { if (texto.includes(k)) sd += 2; });
  if (/creci[\s\-]?\d+/i.test(texto)) si += 5;
  if (si > sd) return 'imobiliaria';
  if (sd > 0)  return 'proprietario';
  return 'indefinido';
}

// ── Fetch JSON helper ────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// ── Busca via API pública do Mercado Livre ───────────────────
// MLB1459 = categoria Imóveis Brasil (gratuita, sem autenticação)
async function buscarImoveis(config) {
  const results = [];
  try {
    const query = `${config.tipo === 'aluguel' ? 'aluguel' : 'venda'} ${config.cidade}`;
    const url   = `https://api.mercadolibre.com/sites/MLB/search?category=MLB1459&q=${encodeURIComponent(query)}&price=${config.precoMin||'*'}-${config.precoMax||'*'}&limit=48`;

    console.log('Buscando:', url);
    const data = await fetchJSON(url);

    if (!data?.results?.length) {
      console.log('Sem resultados. Resposta:', JSON.stringify(data).slice(0, 200));
      return results;
    }

    console.log(`Encontrados ${data.results.length} itens`);

    data.results.forEach(item => {
      const vendedor = item.seller?.nickname || '';
      const attrs    = (item.attributes || []).map(a => `${a.name}: ${a.value_name}`).join(' ');
      const classif  = classificar(item.title, attrs, vendedor);

      results.push({
        id:            `ml-${item.id}`,
        titulo:        item.title,
        preco:         item.price ? `R$ ${item.price.toLocaleString('pt-BR')}` : 'Consulte',
        precoNum:      item.price || 0,
        link:          item.permalink,
        imagem:        (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
        localizacao:   `${item.address?.city_name || config.cidade}, ${item.address?.state_name || config.estado}`,
        anunciante:    vendedor,
        classificacao: classif,
        descricao:     attrs.slice(0, 200),
        site:          'Mercado Livre',
        foundAt:       new Date().toISOString()
      });
    });
  } catch(e) { console.error('Erro busca:', e.message); }
  return results;
}

// ── WhatsApp ─────────────────────────────────────────────────
function sendWhatsApp(config, message) {
  if (!config.whatsappToken || !config.whatsappPhone || !config.whatsappPhoneId) return;
  const body = JSON.stringify({
    messaging_product: 'whatsapp', to: config.whatsappPhone,
    type: 'text', text: { body: message }
  });
  const req = https.request({
    hostname: 'graph.facebook.com',
    path: `/v18.0/${config.whatsappPhoneId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  });
  req.on('error', () => {});
  req.write(body); req.end();
}

// ── Scan principal ───────────────────────────────────────────
let scanning = false;
let lastScanResult = { added: 0, total: 0 };

async function runScan() {
  if (scanning) return lastScanResult;
  scanning = true;
  console.log('🔍 Iniciando varredura...');

  const db          = loadDB();
  const existingIds = new Set(db.imoveis.map(i => i.id));
  const ignorados   = new Set(db.ignorados);
  const novos       = [];

  const encontrados = await buscarImoveis(db.config);

  for (const im of encontrados) {
    if (existingIds.has(im.id) || ignorados.has(im.id)) continue;
    novos.push(im);
    db.imoveis.unshift(im);
    existingIds.add(im.id);
  }

  db.imoveis  = db.imoveis.slice(0, 500);
  db.lastScan = new Date().toISOString();
  db.stats    = {
    total:         db.imoveis.length,
    proprietarios: db.imoveis.filter(i => i.classificacao === 'proprietario').length,
    imobiliarias:  db.imoveis.filter(i => i.classificacao === 'imobiliaria').length
  };
  saveDB(db);

  novos.filter(i => i.classificacao === 'proprietario').slice(0, 3).forEach(im => {
    sendWhatsApp(db.config,
      `🏠 *PROPRIETÁRIO DIRETO!*\n\n📍 ${im.titulo}\n💰 ${im.preco}\n📌 ${im.localizacao}\n\n🔗 ${im.link}`
    );
  });

  lastScanResult = { added: novos.length, total: db.imoveis.length };
  scanning = false;
  console.log(`✅ Concluído. +${novos.length} novos.`);
  return lastScanResult;
}

// ── Cron ─────────────────────────────────────────────────────
let cronJob = null;
function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  const db = loadDB();
  if (!db.config.ativo) return;
  const mins = Math.max(5, db.config.intervaloMinutos || 30);
  cronJob = cron.schedule(`*/${mins} * * * *`, runScan);
  console.log(`⏰ Busca automática a cada ${mins} minutos`);
}
setupCron();

// ── Rotas ────────────────────────────────────────────────────
app.get('/api/data',      (req, res) => res.json(loadDB()));
app.post('/api/config',   (req, res) => {
  const db = loadDB();
  db.config = { ...db.config, ...req.body };
  saveDB(db); setupCron();
  res.json({ ok: true });
});
app.post('/api/scan',     async (req, res) => res.json(await runScan()));
app.post('/api/favorito', (req, res) => {
  const db = loadDB();
  const idx = db.favoritos.indexOf(req.body.id);
  if (idx === -1) db.favoritos.push(req.body.id);
  else db.favoritos.splice(idx, 1);
  saveDB(db); res.json({ ok: true });
});
app.post('/api/ignorar',  (req, res) => {
  const db = loadDB();
  if (!db.ignorados.includes(req.body.id)) db.ignorados.push(req.body.id);
  db.imoveis = db.imoveis.filter(i => i.id !== req.body.id);
  saveDB(db); res.json({ ok: true });
});
app.post('/api/limpar',   (req, res) => {
  const db = loadDB();
  db.imoveis = []; db.stats = { total:0, proprietarios:0, imobiliarias:0 };
  saveDB(db); res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 ImóvelHunter rodando em http://localhost:${PORT}`);
});
