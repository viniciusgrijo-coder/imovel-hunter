 // ============================================================
//  ImóvelHunter Web — Servidor corrigido com categorias certas
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

// ── Classificação ────────────────────────────────────────────
const KEYWORDS_IMOB = [
  'creci','imobiliária','imobiliaria','imóveis','imoveis','corretor',
  'consultoria','empreendimentos','construtora','incorporadora',
  'realty','ltda','s.a.','eireli','administração'
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

// ── Fetch JSON ───────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve) => {
    console.log('GET', url);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { console.error('JSON parse error:', e.message); resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('Fetch error:', e.message); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

// ── Categorias corretas de imóveis MLB ───────────────────────
// MLB1459 = Imóveis (raiz)
// MLB1467 = Apartamentos
// MLB1466 = Casas
// Operação: usamos query text para filtrar aluguel/venda
async function buscarImoveis(config) {
  const results = [];

  // Monta queries para casas e apartamentos
  const categorias = [
    { id: 'MLB1467', nome: 'Apartamentos' },
    { id: 'MLB1466', nome: 'Casas' }
  ];

  for (const cat of categorias) {
    try {
      const query = `${config.tipo} ${config.cidade} ${config.estado}`;
      // Filtro de preço
      const priceFilter = (config.precoMin > 0 || config.precoMax > 0)
        ? `&price=${config.precoMin || '*'}-${config.precoMax || '*'}`
        : '';

      const url = `https://api.mercadolibre.com/sites/MLB/search?category=${cat.id}&q=${encodeURIComponent(query)}${priceFilter}&limit=50`;
      const data = await fetchJSON(url);

      if (!data) { console.log(`Sem resposta para ${cat.nome}`); continue; }
      if (!data.results) { console.log(`Sem results para ${cat.nome}:`, JSON.stringify(data).slice(0,200)); continue; }

      console.log(`${cat.nome}: ${data.results.length} itens encontrados`);

      data.results.forEach(item => {
        const vendedor = item.seller?.nickname || '';
        const attrs    = (item.attributes || []).slice(0, 6).map(a => `${a.name}: ${a.value_name}`).join(' · ');
        const classif  = classificar(item.title, attrs, vendedor);

        results.push({
          id:            `ml-${item.id}`,
          titulo:        item.title,
          preco:         item.price ? `R$ ${Math.round(item.price).toLocaleString('pt-BR')}` : 'Consulte',
          precoNum:      item.price || 0,
          link:          item.permalink,
          imagem:        (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
          localizacao:   [item.address?.city_name, item.address?.state_name].filter(Boolean).join(', ') || config.cidade,
          anunciante:    vendedor,
          classificacao: classif,
          descricao:     attrs,
          site:          'Mercado Livre',
          categoria:     cat.nome,
          foundAt:       new Date().toISOString()
        });
      });
    } catch(e) {
      console.error(`Erro ao buscar ${cat.nome}:`, e.message);
    }
  }

  console.log(`Total encontrado: ${results.length} imóveis`);
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

// ── Scan ─────────────────────────────────────────────────────
let scanning = false;
let lastScanResult = { added: 0, total: 0 };

async function runScan() {
  if (scanning) return lastScanResult;
  scanning = true;
  console.log('\n🔍 Iniciando varredura...');

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
  console.log(`✅ Concluído. +${novos.length} novos. Total: ${db.imoveis.length}\n`);
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

app.get('/api/test',      async (req, res) => {
  // Rota de teste para verificar se a API ML está respondendo
  const data = await fetchJSON('https://api.mercadolibre.com/sites/MLB/search?category=MLB1467&q=aluguel+Cabo+Frio&limit=3');
  res.json({ ok: !!data?.results, total: data?.results?.length || 0, sample: data?.results?.[0] || null });
});

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
  console.log(`🧪 Teste a API em: http://localhost:${PORT}/api/test`);
});
