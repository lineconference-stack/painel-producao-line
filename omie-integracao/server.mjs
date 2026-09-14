import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
loadEnv(join(root, '.env'));

const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://lineconference-stack.github.io';
const dbPath = join(root, 'data', 'omie-orders.json');
const omieUrl = 'https://app.omie.com.br/api/v1/produtos/pedido/';
const omieProductUrl = 'https://app.omie.com.br/api/v1/geral/produtos/';
const omieClientUrl = 'https://app.omie.com.br/api/v1/geral/clientes/';
const productImageCache = new Map();
const companies = [
  { name: 'Line Conference', key: process.env.OMIE_LINE_APP_KEY, secret: process.env.OMIE_LINE_APP_SECRET },
  { name: 'GLO Equipamentos', key: process.env.OMIE_GLO_APP_KEY, secret: process.env.OMIE_GLO_APP_SECRET }
];

function loadEnv(file) {
  try {
    const rows = requireText(file).split(/\r?\n/);
    for (const row of rows) {
      const match = row.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional until credentials are provided */ }
}
function requireText(file) {
  // Synchronous read only happens once during startup.
  return readFileSync(file, 'utf8');
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': allowedOrigin, 'vary': 'origin' });
  res.end(JSON.stringify(value));
}
function cors(res) {
  res.setHeader('access-control-allow-origin', allowedOrigin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-integration-token');
  res.setHeader('vary', 'origin');
}
async function readDb() {
  try { return JSON.parse(await readFile(dbPath, 'utf8')); }
  catch { return { orders: [], lastSyncAt: null, lastError: null }; }
}
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  const temp = `${dbPath}.tmp`;
  await writeFile(temp, JSON.stringify(db, null, 2));
  await rename(temp, dbPath);
}
async function omieCall(company, call, param, serviceUrl = omieUrl) {
  const response = await fetch(serviceUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ call, app_key: company.key, app_secret: company.secret, param: [param] })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.faultstring || body.faultcode) throw new Error(body.faultstring || `Omie respondeu ${response.status}`);
  return body;
}
function dateISO(value) {
  const m = String(value || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().slice(0, 10);
}
function dateBrazil(value) {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function text(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function statusFromStage(stage) {
  return ({ '10': 'A separar', '20': 'Montando', '30': 'Separando', '40': 'Separado', '50': 'Faturado' })[String(stage)] || 'A separar';
}
function shippingFromOrder(order) {
  const extra = order.informacoes_adicionais || {};
  const freight = order.frete || {};
  return {
    recipient: text(extra.cNomeOd || order.cliente?.razao_social || order.cabecalho?.nome_cliente || ''),
    document: text(extra.cCnpjCpfOd || ''),
    address: text([extra.cEnderecoOd, extra.cNumeroOd, extra.cComplementoOd].filter(Boolean).join(', ')),
    district: text(extra.cBairroOd || ''),
    city: text(extra.cCidadeOd || ''),
    state: text(extra.cEstadoOd || ''),
    zip: text(extra.cCEPOd || ''),
    phone: text(extra.cTelefoneOd || ''),
    volumes: Number(freight.quantidade_volumes || 1),
    species: text(freight.especie_volumes || 'Volume'),
    tracking: text(freight.codigo_rastreio || '')
  };
}
function normaliseOrder(company, order) {
  const header = order.cabecalho || {};
  const details = Array.isArray(order.det) ? order.det : [];
  const orderNumber = text(header.numero_pedido || header.codigo_pedido);
  return {
    id: `omie:${company.name}:${header.codigo_pedido}`,
    source: 'omie',
    company: company.name,
    omieId: String(header.codigo_pedido || ''),
    code: `${company.name === 'GLO Equipamentos' ? 'GLO' : 'LINE'}-${orderNumber}`,
    client: text(order.cliente?.razao_social || order.cabecalho?.nome_cliente || ''),
    shipping: shippingFromOrder(order),
    invoice: text(order.lista_nfe?.nfe?.[0]?.numero_nfe || ''),
    date: dateISO(header.data_previsao),
    status: statusFromStage(header.etapa),
    items: details.map((detail) => {
      const product = detail.produto || {};
      return {
        // `codigo` é o código comercial do produto; `codigo_produto` é o ID
        // interno do Omie. O painel deve sempre mostrar o código comercial.
        code: text(product.codigo || product.codigo_produto || detail.ide?.codigo_item_integracao),
        description: text(product.descricao),
        quantity: Number(product.quantidade || 0)
      };
    }).filter((item) => item.code && item.description && item.quantity > 0),
    updatedAt: new Date().toISOString()
  };
}
async function mapWithLimit(items, limit, callback) {
  const result = []; let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      result[current] = await callback(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}
async function syncCompany(company, knownOrders) {
  if (!company.key || !company.secret) return { company: company.name, skipped: true, reason: 'Credenciais não configuradas' };
  // Etapas 10 a 40 são os pedidos que ainda exigem produção ou separação.
  // Não trazemos o histórico faturado, que poderia tornar a primeira carga muito lenta.
  const summaries = [];
  for (const etapa of ['10', '20', '30', '40']) {
    try {
      // A etapa é a fonte de verdade: ela traz todos os pedidos ainda abertos,
      // inclusive os iniciados antes da implantação do painel.
      const first = await omieCall(company, 'ListarPedidos', { pagina: 1, registros_por_pagina: 100, etapa, apenas_resumo: 'S' });
      summaries.push(...(first.pedido_venda_produto || first.pedidos || []));
      const pages = Number(first.total_de_paginas || 1);
      for (let page = 2; page <= pages; page += 1) {
        const next = await omieCall(company, 'ListarPedidos', { pagina: page, registros_por_pagina: 100, etapa, apenas_resumo: 'S' });
        summaries.push(...(next.pedido_venda_produto || next.pedidos || []));
      }
    } catch (error) {
      // O Omie responde com erro quando uma etapa simplesmente não possui pedidos.
      if (!/não existem registros|nao existem registros/i.test(error.message)) throw error;
    }
  }
  const imported = (await mapWithLimit(summaries, 4, async (summary) => {
    const omieId = summary.cabecalho?.codigo_pedido || summary.codigo_pedido;
    if (!omieId) return null;
    const id = `omie:${company.name}:${omieId}`;
    const existing = knownOrders.get(id);
    // Nas próximas sincronizações só consultamos detalhes de pedido novo. A
    // etapa vem da listagem e continua atualizando o cartão automaticamente.
    if (existing) return { ...existing, status: statusFromStage(summary.cabecalho?.etapa), updatedAt: existing.updatedAt };
    const complete = await omieCall(company, 'ConsultarPedido', { codigo_pedido: omieId });
    // A resposta de consulta vem dentro de pedido_venda_produto. Mantemos o
    // fallback para compatibilidade com versões antigas da API.
    const order = normaliseOrder(company, complete.pedido_venda_produto || complete);
    return order.items.length ? order : null;
  })).filter(Boolean);
  return { company: company.name, imported, openOrders: summaries.length };
}
async function syncAll() {
  const db = await readDb();
  const results = [];
  try {
    const existing = new Map(db.orders.map((order) => [order.id, order]));
    for (const company of companies) {
      const result = await syncCompany(company, existing);
      results.push(result);
      // A primeira carga pode levar alguns minutos. Salvamos empresa a empresa
      // para que o painel já comece a exibir os pedidos disponíveis.
      for (const order of result.imported || []) existing.set(order.id, { ...existing.get(order.id), ...order });
      db.orders = [...existing.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      await saveDb(db);
    }
    db.lastSyncAt = new Date().toISOString(); db.lastError = null;
    await saveDb(db);
    return { ...db, results };
  } catch (error) {
    db.lastError = error.message; await saveDb(db); throw error;
  }
}
async function body(req) {
  let raw = ''; for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, configuredCompanies: companies.filter(c => c.key && c.secret).map(c => c.name) });
    if (req.method === 'GET' && url.pathname === '/api/orders') { const db = await readDb(); return json(res, 200, db); }
    if (req.method === 'GET' && url.pathname === '/api/order-details') {
      const companyName = text(url.searchParams.get('company'));
      const omieId = text(url.searchParams.get('omieId'));
      const company = companies.find((item) => item.name === companyName);
      if (!company || !omieId) return json(res, 400, { error: 'Empresa ou pedido inválido' });
      const complete = await omieCall(company, 'ConsultarPedido', { codigo_pedido: omieId });
      const rawOrder = complete.pedido_venda_produto || complete;
      const order = normaliseOrder(company, rawOrder);
      const clientId = rawOrder.cabecalho?.codigo_cliente;
      let customer = {};
      if (clientId) customer = await omieCall(company, 'ConsultarCliente', { codigo_cliente_omie: clientId }, omieClientUrl);
      const shipping = {
        ...order.shipping,
        recipient: order.shipping.recipient || text(customer.razao_social || customer.nome_fantasia),
        document: order.shipping.document || text(customer.cnpj_cpf),
        address: order.shipping.address || text([customer.endereco, customer.endereco_numero, customer.complemento].filter(Boolean).join(', ')),
        district: order.shipping.district || text(customer.bairro),
        city: order.shipping.city || text(customer.cidade),
        state: order.shipping.state || text(customer.estado),
        zip: order.shipping.zip || text(customer.cep),
        phone: order.shipping.phone || text(customer.telefone1_numero || customer.telefone2_numero)
      };
      return json(res, 200, { client: order.client || shipping.recipient, shipping, invoice: order.invoice });
    }
    if (req.method === 'GET' && url.pathname === '/api/product-image') {
      const companyName = text(url.searchParams.get('company'));
      const code = text(url.searchParams.get('code'));
      const company = companies.find((item) => item.name === companyName);
      if (!company || !code) return json(res, 400, { error: 'Empresa ou produto inválido' });
      const cacheKey = `${companyName}:${code.toUpperCase()}`;
      if (productImageCache.has(cacheKey)) return json(res, 200, { imageUrl: productImageCache.get(cacheKey) });
      const product = await omieCall(company, 'ConsultarProduto', { codigo: code }, omieProductUrl);
      const images = Array.isArray(product.imagens) ? product.imagens : [];
      const imageUrl = text(images.find((image) => image?.url_imagem)?.url_imagem || '');
      productImageCache.set(cacheKey, imageUrl);
      return json(res, 200, { imageUrl });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') return json(res, 200, await syncAll());
    if (req.method === 'POST' && /^\/api\/orders\/[^/]+\/status$/.test(url.pathname)) {
      const code = decodeURIComponent(url.pathname.split('/')[3]); const input = await body(req);
      const db = await readDb(); const order = db.orders.find((item) => item.code === code);
      if (!order) return json(res, 404, { error: 'Pedido não encontrado' });
      order.status = text(input.status); order.updatedAt = new Date().toISOString(); await saveDb(db);
      return json(res, 200, order);
    }
    return json(res, 404, { error: 'Rota não encontrada' });
  } catch (error) { return json(res, 500, { error: error.message || 'Falha na integração' }); }
});

server.listen(port, async () => {
  console.log(`Integração Omie disponível na porta ${port}`);
  try { await syncAll(); } catch (error) { console.warn(`Aguardando credenciais Omie: ${error.message}`); }
});
const minutes = Math.max(1, Number(process.env.OMIE_SYNC_INTERVAL_MINUTES || 5));
setInterval(() => syncAll().catch((error) => console.warn(`Falha na sincronização: ${error.message}`)), minutes * 60_000);
