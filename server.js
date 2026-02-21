require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEBUG = process.env.DEBUG === 'true';
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';

function log(...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}

function logSep(title) {
  if (!DEBUG) return;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// 1. Caricamento contenuti in memoria
// ---------------------------------------------------------------------------

const contentMap = new Map();

function loadContentDir(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      loadContentDir(fullPath, relativePath);
    } else {
      contentMap.set(relativePath, fs.readFileSync(fullPath, 'utf-8'));
    }
  }
}

const contentDir = path.join(__dirname, 'content');
if (fs.existsSync(contentDir)) {
  loadContentDir(contentDir);
  console.log(`Caricati ${contentMap.size} file di contenuto in memoria`);
} else {
  console.error('ATTENZIONE: cartella content/ non trovata');
}

// Build product name lookup from catalog
const productLookup = new Map();
try {
  const catalog = JSON.parse(contentMap.get('catalog.json') || '{}');
  for (const cat of catalog.categories || []) {
    if (cat.lines) {
      for (const line of cat.lines) {
        for (const p of line.products) {
          productLookup.set(p.id, { name: `${line.name} ${p.name}`, price: p.price });
        }
      }
    } else {
      for (const p of cat.products || []) {
        productLookup.set(p.id, { name: p.name, price: p.price });
      }
    }
  }
} catch {}

// ---------------------------------------------------------------------------
// 2. System prompt (per pagine generative)
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const role =
    'Sei il motore di rendering del sito DPG Nutrition. Generi ESCLUSIVAMENTE ' +
    'frammenti HTML validi da iniettare dentro <div id="content">. ' +
    'Usa SOLO classi Tailwind CSS (già caricato con colori custom DPG). ' +
    'NON generare <html>, <head>, <body>, header o footer — sono già nella shell. ' +
    'NON includere librerie esterne. NON scrivere <style> salvo eccezioni rare. ' +
    'REGOLA ASSOLUTA: il tuo output deve contenere SOLO tag HTML. ' +
    'Mai markdown, mai testo libero, mai commenti fuori dall\'HTML, mai backtick. ' +
    'I suggerimenti di navigazione vanno come link HTML con data-navigate.';

  const interactionRules = contentMap.get('system/interaction-rules.md') || '';
  const brandGuidelines = contentMap.get('system/brand-guidelines.md') || '';
  const sitemap = contentMap.get('system/sitemap.md') || '';
  const catalog = contentMap.get('catalog.json') || '';

  return [
    role,
    '\n\n---\n\n## Interaction Rules\n\n' + interactionRules,
    '\n\n---\n\n## Brand Guidelines\n\n' + brandGuidelines,
    '\n\n---\n\n## Sitemap (file disponibili per CFD)\n\n' + sitemap,
    '\n\n---\n\n## Catalogo Prodotti\n\n```json\n' + catalog + '\n```',
  ].join('');
}

const systemPrompt = buildSystemPrompt();
log(`System prompt: ${systemPrompt.length} caratteri`);

// ---------------------------------------------------------------------------
// 3. Utilità
// ---------------------------------------------------------------------------

const CFD_PATTERN = /^CFD:((?:"[^"]+",?\s*)+)$/;

function parseCFD(text) {
  const trimmed = text.trim();
  const match = trimmed.match(CFD_PATTERN);
  if (!match) return null;
  const files = [];
  const filePattern = /"([^"]+)"/g;
  let m;
  while ((m = filePattern.exec(match[1])) !== null) files.push(m[1]);
  return files.length > 0 ? files : null;
}

function stripCodeFence(text) {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:html|json)?\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
  }
  return s.trim();
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 4. Chiamata Claude (full — per generative e template)
// ---------------------------------------------------------------------------

async function callClaude(messages, requestId, opts = {}) {
  const sys = opts.system || systemPrompt;
  const maxTokens = opts.max_tokens || 12000;

  log(`[${requestId}] Chiamata API (${MODEL}, max_tokens=${maxTokens})...`);
  const start = Date.now();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: sys, messages }),
  });

  const elapsed = Date.now() - start;
  if (!res.ok) {
    const body = await res.text();
    log(`[${requestId}] API ERRORE ${res.status} (${elapsed}ms): ${body.slice(0, 300)}`);
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  const usage = data.usage || {};
  log(`[${requestId}] API OK (${elapsed}ms) — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);
  return text;
}

// ===========================================================================
// 5. USER PROFILING (generico — funziona con qualsiasi sito/brand)
// ===========================================================================

function buildUserProfile(journey) {
  if (!journey || journey.length === 0) return null;

  const recent = journey.slice(-10);
  const all = journey.join(' | ');

  return {
    summary: `L'utente ha visitato ${journey.length} pagine. Percorso recente: ${recent.join(' → ')}`,
    intents: recent,
    total: journey.length,
    raw: all,
  };
}

function profileToPromptContext(profile) {
  if (!profile) return '';
  return (
    '\n\n--- PROFILO UTENTE (adatta tono e contenuti) ---\n' +
    `Pagine visitate: ${profile.total}\n` +
    `Percorso recente: ${profile.intents.join(' → ')}\n` +
    'Analizza il percorso per capire gli interessi dell\'utente e adatta: ' +
    'tono, focus dei contenuti, prodotti suggeriti, link di navigazione proposti. ' +
    'Se emergono pattern chiari (es. focus su dieta, performance, vegano, ricette), ' +
    'enfatizza quegli aspetti. Non menzionare esplicitamente il tracking.\n' +
    '--- FINE PROFILO ---'
  );
}

// ===========================================================================
// 6. PRODUCT TEMPLATE SYSTEM
// ===========================================================================

let productTemplate = null;

const PRODUCT_ID_RE = /\b(BAR-[CV]-\d{3}|FLR-\d{3}|SPR-\d{3})\b/i;
const CATEGORY_EMOJIS = { bars: '🍫', flours: '🌾', spreads: '🥜' };
const CATEGORY_LABELS = { bars: 'Barrette Proteiche', flours: 'Farine Proteiche', spreads: 'Creme Spalmabili' };

function detectProductId(intent) {
  const m = intent.match(PRODUCT_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

function loadProduct(productId) {
  const raw = contentMap.get(`products/${productId.toLowerCase()}.json`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// --- HTML builders (dati → Tailwind HTML) ---

function buildNutritionTable(nutrition) {
  const rows = (obj, label) => {
    const fields = [
      ['Energia', `${obj.energy_kcal} kcal / ${obj.energy_kj} kJ`],
      ['Grassi', `${obj.fat_g}g`], ['  di cui saturi', `${obj.saturated_fat_g}g`],
      ['Carboidrati', `${obj.carbs_g}g`], ['  di cui zuccheri', `${obj.sugars_g}g`],
      ['Fibre', `${obj.fiber_g}g`], ['Proteine', `${obj.protein_g}g`], ['Sale', `${obj.salt_g}g`],
    ];
    return `<div>
      <h4 class="text-sm font-bold text-dpg-dark mb-2">${esc(label)}</h4>
      <table class="w-full text-sm"><tbody>
        ${fields.map(([k, v]) => `<tr class="border-b border-gray-100"><td class="py-1.5 ${k.startsWith('  ') ? 'pl-4 text-gray-500' : 'font-medium'}">${esc(k.trim())}</td><td class="py-1.5 text-right">${esc(v)}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  };
  return `<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
    ${rows(nutrition.per_100g, 'Per 100g')}
    ${rows(nutrition.per_unit, nutrition.per_unit.unit_label || 'Per porzione')}
  </div>`;
}

function buildAllergensHtml(allergens) {
  let html = '';
  if (allergens.contains?.length) {
    html += `<span class="text-alert font-bold text-sm">Contiene: ${allergens.contains.join(', ')}</span>`;
  }
  if (allergens.may_contain?.length) {
    html += `<span class="text-alert/70 font-medium text-sm ml-3">Può contenere: ${allergens.may_contain.join(', ')}</span>`;
  }
  return html;
}

function buildUsageTipsHtml(tips, creativeTip) {
  let html = '<ul class="space-y-2">';
  for (const tip of tips) {
    html += `<li class="flex gap-2 text-sm"><span class="text-dpg shrink-0">▸</span><span>${esc(tip)}</span></li>`;
  }
  if (creativeTip) {
    html += `<li class="flex gap-2 text-sm mt-3 bg-dpg-light/50 rounded-lg p-3"><span class="text-dpg shrink-0">💡</span><span class="italic">${esc(creativeTip)}</span></li>`;
  }
  html += '</ul>';
  return html;
}

function buildRelatedProductsHtml(ids) {
  if (!ids?.length) return '';
  return `<div class="flex gap-3 flex-wrap">
    ${ids.map(id => {
      const info = productLookup.get(id);
      const name = info ? info.name : id;
      return `<a href="#" data-navigate="dettaglio prodotto ${id}" onclick="return false;" class="bg-white border border-dpg/10 rounded-lg px-4 py-3 text-sm font-medium hover:-translate-y-0.5 hover:shadow-md transition-all">${esc(name)}</a>`;
    }).join('')}
  </div>`;
}

function buildRelatedRecipesHtml(slugs) {
  if (!slugs?.length) return '';
  const labels = {
    'pancake-proteico': 'Pancake Proteico', 'energy-balls': 'Energy Balls',
    'overnight-oats': 'Overnight Oats', 'banana-bread': 'Banana Bread',
  };
  return `<div class="flex gap-2 flex-wrap">
    ${slugs.map(s => `<a href="#" data-navigate="ricetta ${s.replace(/-/g, ' ')}" onclick="return false;" class="bg-dpg-light text-dpg-dark px-4 py-2 rounded-full text-sm font-medium hover:bg-dpg-accent/30 transition-all">${esc(labels[s] || s)}</a>`).join('')}
  </div>`;
}

function buildBestsellerBadge(product) {
  if (!product.is_bestseller) return '';
  return `<span class="bg-gold text-dpg-dark px-3 py-1 rounded-full text-xs font-bold">⭐ Bestseller</span>`;
}

function buildCertificationsHtml(certs) {
  if (!certs?.length) return '';
  return `<div class="flex gap-2 flex-wrap">
    ${certs.map(c => `<span class="bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs">${esc(c)}</span>`).join('')}
  </div>`;
}

function buildCategoryExtrasHtml(product) {
  let html = '';

  if (product.nutrition?.amino_acids_per_unit) {
    const aa = product.nutrition.amino_acids_per_unit;
    html += `<div class="bg-dpg-light/30 rounded-xl p-5">
      <h4 class="text-sm font-bold text-dpg-dark mb-3">Aminoacidi per unità</h4>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        ${Object.entries(aa).map(([k, v]) => `<div class="bg-white rounded-lg p-3 text-center"><div class="font-bold text-dpg">${v}g</div><div class="text-gray-500 text-xs">${esc(k.replace(/_/g, ' '))}</div></div>`).join('')}
      </div>
    </div>`;
  }

  if (product.nutrition?.lipid_profile_per_100g) {
    const lp = product.nutrition.lipid_profile_per_100g;
    html += `<div class="bg-earth/5 rounded-xl p-5">
      <h4 class="text-sm font-bold text-dpg-dark mb-3">Profilo lipidico (per 100g)</h4>
      <div class="grid grid-cols-2 gap-3 text-sm">
        ${Object.entries(lp).map(([k, v]) => `<div class="bg-white rounded-lg p-3 text-center"><div class="font-bold text-earth">${v}g</div><div class="text-gray-500 text-xs">${esc(k.replace(/_/g, ' '))}</div></div>`).join('')}
      </div>
    </div>`;
  }

  if (product.comparison_vs_standard) {
    const c = product.comparison_vs_standard;
    html += `<div class="bg-cat-flour/10 rounded-xl p-5">
      <h4 class="text-sm font-bold text-dpg-dark mb-3">Confronto vs farina standard</h4>
      <table class="w-full text-sm"><thead><tr class="border-b-2 border-cat-flour/30"><th class="text-left py-2"></th><th class="text-right py-2 font-bold text-dpg">DPG</th><th class="text-right py-2 text-gray-400">Standard</th></tr></thead>
      <tbody>
        <tr class="border-b border-gray-100"><td class="py-2">Proteine/100g</td><td class="text-right font-bold text-dpg">${c.dpg_protein_per_100g}g</td><td class="text-right text-gray-400">${c.standard_protein_per_100g}g</td></tr>
        <tr class="border-b border-gray-100"><td class="py-2">Fibre/100g</td><td class="text-right font-bold text-dpg">${c.dpg_fiber_per_100g}g</td><td class="text-right text-gray-400">${c.standard_fiber_per_100g}g</td></tr>
        <tr><td class="py-2">Carboidrati/100g</td><td class="text-right font-bold text-dpg">${c.dpg_carbs_per_100g}g</td><td class="text-right text-gray-400">${c.standard_carbs_per_100g}g</td></tr>
      </tbody></table>
    </div>`;
  }

  return html;
}

// --- Template generation (first time only) ---

async function generateProductTemplate(requestId) {
  log(`[${requestId}] Generazione template prodotto (prima volta)...`);

  const templatePrompt =
    'Genera una pagina DETTAGLIO PRODOTTO per DPG Nutrition.\n' +
    'REGOLA FONDAMENTALE: al posto dei dati reali, usa ESATTAMENTE questi placeholder. ' +
    'Non modificarli, non avvolgerli in altri tag, scrivili esattamente così:\n\n' +
    '{{CATEGORY_EMOJI}} — emoji della categoria\n' +
    '{{NAME}} — nome prodotto\n' +
    '{{PRICE}} — prezzo formattato\n' +
    '{{WEIGHT}} — peso\n' +
    '{{BESTSELLER_BADGE}} — badge bestseller (può essere stringa vuota)\n' +
    '{{DESCRIPTION_LONG}} — descrizione lunga dal database\n' +
    '{{MARKETING}} — testo marketing AI\n' +
    '{{EXPERT_NOTE}} — nota esperto AI\n' +
    '{{INGREDIENTS}} — lista ingredienti testuale\n' +
    '{{ALLERGENS_HTML}} — HTML precostruito con badge allergeni\n' +
    '{{NUTRITION_TABLE}} — HTML precostruito tabella nutrizionale\n' +
    '{{CATEGORY_EXTRAS}} — HTML precostruito sezioni extra per categoria\n' +
    '{{USAGE_TIPS_HTML}} — HTML precostruito consigli d\'uso\n' +
    '{{RELATED_PRODUCTS_HTML}} — HTML precostruito prodotti correlati\n' +
    '{{RELATED_RECIPES_HTML}} — HTML precostruito ricette correlate\n' +
    '{{STORAGE}} — info conservazione\n' +
    '{{CERTIFICATIONS_HTML}} — HTML precostruito certificazioni\n\n' +
    'Layout richiesto: hero section con emoji+nome+prezzo+badge, ' +
    'sezione descrizione con marketing AI, callout nota esperto, ' +
    'tabella nutrizionale, allergeni ben visibili, ingredienti, ' +
    'extras di categoria, consigli d\'uso, prodotti e ricette correlate, conservazione, certificazioni.\n' +
    'Usa classi Tailwind con colori custom DPG (bg-dpg, text-dpg-dark, bg-dpg-light, text-alert, bg-gold, ecc.).\n' +
    'I placeholder che finiscono con _HTML sono già blocchi HTML completi — inseriscili direttamente senza tag wrapper.\n' +
    'Il layout deve essere elegante, con molto spazio bianco, card e sezioni ben separate.';

  const reply = await callClaude(
    [{ role: 'user', content: templatePrompt }],
    requestId,
    { max_tokens: 6000 }
  );

  productTemplate = stripCodeFence(reply);
  log(`[${requestId}] Template salvato (${productTemplate.length} char, ${(productTemplate.match(/\{\{/g) || []).length} placeholder trovati)`);
  return productTemplate;
}

// --- Enrichment LLM (leggero, ~300 token) ---

async function enrichProduct(product, requestId, userProfile) {
  log(`[${requestId}] Enrichment per "${product.name}"${userProfile ? ` (profilo: ${userProfile.total} pagine)` : ''}...`);

  const enrichSystem =
    'Sei un copywriter per DPG Nutrition. Tono: diretto, competente, amichevole, onesto. ' +
    'Come un amico esperto del settore. Mai superlative, mai claims salutistici, mai marketing aggressivo. ' +
    'Rispondi SOLO con un oggetto JSON valido. Niente altro testo, niente backtick, niente markdown.';

  let enrichUser =
    `Prodotto: ${product.name}\nCategoria: ${product.category}\nDescrizione: ${product.description.short}\nIngredienti: ${product.ingredients.slice(0, 100)}\n\n`;

  if (userProfile) {
    enrichUser += `Percorso utente: ${userProfile.intents.join(' → ')}\n` +
      'Adatta il tono e il focus ai suoi interessi (es. se cerca dieta → enfatizza calorie e leggerezza, ' +
      'se cerca performance → enfatizza proteine e recupero, se cerca ricette → suggerisci abbinamenti).\n\n';
  }

  enrichUser +=
    'Genera questo JSON:\n' +
    '{"marketing":"2-3 frasi accattivanti che descrivono l\'esperienza del prodotto","expert_note":"1 frase pratica da esperto nutrizionista","creative_tip":"1 suggerimento originale e specifico per usare il prodotto in modo inaspettato"}';

  const reply = await callClaude(
    [{ role: 'user', content: enrichUser }],
    requestId,
    { system: enrichSystem, max_tokens: 400 }
  );

  const cleaned = stripCodeFence(reply);
  try {
    return JSON.parse(cleaned);
  } catch {
    log(`[${requestId}] Enrichment JSON parse fallito, tentativo recupero...`);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    return { marketing: '', expert_note: '', creative_tip: '' };
  }
}

// --- Fill template ---

function fillProductTemplate(template, product, enrichment) {
  const emoji = CATEGORY_EMOJIS[product.category] || '📦';
  const price = product.price_box_12
    ? `€${product.price.toFixed(2)} — Box 12: €${product.price_box_12.toFixed(2)}`
    : `€${product.price.toFixed(2)}`;

  return template
    .replaceAll('{{CATEGORY_EMOJI}}', emoji)
    .replaceAll('{{NAME}}', esc(product.name))
    .replaceAll('{{PRICE}}', price)
    .replaceAll('{{WEIGHT}}', `${product.weight_g}g`)
    .replaceAll('{{BESTSELLER_BADGE}}', buildBestsellerBadge(product))
    .replaceAll('{{DESCRIPTION_LONG}}', esc(product.description.long))
    .replaceAll('{{MARKETING}}', esc(enrichment.marketing || ''))
    .replaceAll('{{EXPERT_NOTE}}', esc(enrichment.expert_note || ''))
    .replaceAll('{{INGREDIENTS}}', esc(product.ingredients))
    .replaceAll('{{ALLERGENS_HTML}}', buildAllergensHtml(product.allergens))
    .replaceAll('{{NUTRITION_TABLE}}', buildNutritionTable(product.nutrition))
    .replaceAll('{{CATEGORY_EXTRAS}}', buildCategoryExtrasHtml(product))
    .replaceAll('{{USAGE_TIPS_HTML}}', buildUsageTipsHtml(product.usage_tips, enrichment.creative_tip))
    .replaceAll('{{RELATED_PRODUCTS_HTML}}', buildRelatedProductsHtml(product.related_products))
    .replaceAll('{{RELATED_RECIPES_HTML}}', buildRelatedRecipesHtml(product.related_recipes))
    .replaceAll('{{STORAGE}}', esc(product.storage))
    .replaceAll('{{CERTIFICATIONS_HTML}}', buildCertificationsHtml(product.certifications));
}

// --- Main product page handler ---

async function handleProductPage(productId, requestId, userProfile) {
  const product = loadProduct(productId);
  if (!product) {
    log(`[${requestId}] Prodotto ${productId} non trovato`);
    return null;
  }

  if (!productTemplate) {
    await generateProductTemplate(requestId);
  }

  const enrichment = await enrichProduct(product, requestId, userProfile);
  return fillProductTemplate(productTemplate, product, enrichment);
}

// ===========================================================================
// 6. Endpoint POST /api/generate
// ===========================================================================

const MAX_CFD_CYCLES = 3;
let requestCounter = 0;

app.post('/api/generate', async (req, res) => {
  const requestId = `REQ-${++requestCounter}`;
  const requestStart = Date.now();

  try {
    const { intent, journey } = req.body;

    logSep(`${requestId} — Nuova richiesta`);
    log(`[${requestId}] Intent: "${intent}"`);
    log(`[${requestId}] Modello: ${MODEL}`);

    const userProfile = buildUserProfile(journey);
    if (userProfile) {
      log(`[${requestId}] Profilo: ${userProfile.total} pagine`);
      log(`[${requestId}] Journey completa: [${userProfile.intents.join(' → ')}]`);
      log(`[${requestId}] Contesto profilo per LLM:\n${profileToPromptContext(userProfile)}`);
    } else {
      log(`[${requestId}] Nessun profilo (prima visita)`);
    }

    if (!intent) {
      return res.status(400).json({ error: 'Campo "intent" obbligatorio' });
    }

    // --- Fast path: product page via template ---
    const productId = detectProductId(intent);
    if (productId) {
      log(`[${requestId}] Prodotto rilevato: ${productId} → flusso template`);
      const html = await handleProductPage(productId, requestId, userProfile);
      if (html) {
        const totalMs = Date.now() - requestStart;
        log(`[${requestId}] Pagina prodotto (${html.length} char)`);
        log(`[${requestId}] COMPLETATA in ${totalMs}ms ${productTemplate ? '(template riusato)' : '(template generato)'}`);
        return res.json({ html });
      }
      log(`[${requestId}] Prodotto non trovato, fallback generativo`);
    }

    // --- Slow path: full generative (CFD loop) ---
    let userMessage = intent;
    const profileContext = profileToPromptContext(userProfile);
    if (profileContext) userMessage += profileContext;

    const messages = [{ role: 'user', content: userMessage }];

    for (let cycle = 0; cycle <= MAX_CFD_CYCLES; cycle++) {
      log(`[${requestId}] Ciclo ${cycle + 1}/${MAX_CFD_CYCLES + 1}`);

      const reply = await callClaude(messages, requestId);
      const requestedFiles = parseCFD(reply);

      if (!requestedFiles) {
        const html = stripCodeFence(reply);
        const totalMs = Date.now() - requestStart;
        log(`[${requestId}] HTML finale (${html.length} char)`);
        log(`[${requestId}] COMPLETATA in ${totalMs}ms (${cycle + 1} chiamate API)`);
        return res.json({ html });
      }

      if (cycle >= MAX_CFD_CYCLES) {
        return res.status(500).json({ error: 'Troppi cicli CFD — generazione interrotta' });
      }

      log(`[${requestId}] CFD: [${requestedFiles.join(', ')}]`);

      const parts = [];
      for (const filePath of requestedFiles) {
        const content = contentMap.get(filePath);
        if (content) {
          log(`[${requestId}]   ✓ ${filePath} (${content.length} char)`);
          parts.push(`--- ${filePath} ---\n${content}\n--- fine ---`);
        } else {
          log(`[${requestId}]   ✗ ${filePath} (NON TROVATO)`);
          parts.push(`--- ${filePath} ---\n[File non trovato]\n--- fine ---`);
        }
      }

      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: 'Ecco i file richiesti:\n\n' + parts.join('\n\n') + '\n\nOra genera la pagina HTML.',
      });
    }
  } catch (err) {
    const totalMs = Date.now() - requestStart;
    log(`[${requestId}] ERRORE dopo ${totalMs}ms: ${err.message}`);
    console.error('Errore generazione:', err);
    res.status(500).json({ error: err.message || 'Errore interno del server' });
  }
});

// ---------------------------------------------------------------------------
// 7. Avvio
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DPG Nutrition RTR attivo su http://localhost:${PORT}`);
  console.log(`Modello: ${MODEL}`);
  console.log(`Prodotti in catalogo: ${productLookup.size}`);
  if (DEBUG) console.log('Debug logging ATTIVO');
});
