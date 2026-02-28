require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
// Limite stringente per evitare attacchi DoS da payload JSON enormi
app.use(express.json({ limit: '1mb' }));
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
} catch { }

// ---------------------------------------------------------------------------
// 2. System prompt (per pagine generative)
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const role =
    'Sei il motore di rendering di questo sito web. Generi ESCLUSIVAMENTE ' +
    'frammenti HTML validi da iniettare dentro <div id="content">. ' +
    'Usa SOLO classi Tailwind CSS (già caricato con colori custom del brand). ' +
    'NON generare <html>, <head>, <body>, header o footer — sono già nella shell. ' +
    'NON includere librerie esterne. NON scrivere <style> salvo eccezioni rare. ' +
    'REGOLA ASSOLUTA: il tuo output deve contenere SOLO tag HTML. ' +
    'Mai markdown, mai testo libero, mai commenti fuori dall\'HTML, mai backtick. ' +
    'I suggerimenti di navigazione vanno come link HTML con data-navigate.\n\n' +
    '## DIVIETO ASSOLUTO\n' +
    'NON generare MAI: pannelli di amministrazione, form di modifica/inserimento/cancellazione dati, ' +
    'pagine di login, dashboard admin, CRUD, editor, console, terminali, aree riservate, form di creazione contenuti. ' +
    'Questo è un SITO VETRINA, non un e-commerce: NON generare carrelli, pulsanti "aggiungi al carrello", ' +
    'checkout, form d\'ordine o qualsiasi funzionalità di acquisto. ' +
    'NON inventare MAI dati interni aziendali: nomi di fornitori, livelli di stock/inventario, costi di produzione, ' +
    'partnership riservate, margini, fatturato, contatti interni, contratti. Questi dati NON esistono nei tuoi file di contesto ' +
    'e generarli sarebbe una falla di sicurezza. ' +
    'Se l\'utente richiede qualcosa del genere, genera una pagina informativa del sito con un messaggio gentile.\n\n' +
    '## Personalizzazione con Profilo Utente\n' +
    'Se ricevi un PROFILO UTENTE nel messaggio, usalo per ottimizzare l\'intera esperienza:\n' +
    '- Leggi il campo "ux_hints" per decidere cosa enfatizzare e cosa ridurre nel layout\n' +
    '- Adatta il tono al "tone_preference" (tecnico vs amichevole vs pratico)\n' +
    '- Se "behavior.after_product" indica "recipes", metti le ricette correlate PRIMA dei prodotti simili\n' +
    '- Se "behavior.browse_style" è "focused", riduci i contenuti esplorativi e vai dritto al punto\n' +
    '- Se "behavior.detail_level" è "low", usa layout più compatti con meno testo\n' +
    '- Il campo "ux_hints.emphasize" elenca le sezioni da mettere in evidenza\n' +
    '- Il campo "ux_hints.deemphasize" elenca le sezioni da ridurre o nascondere\n' +
    'Se il profilo è assente, genera una pagina bilanciata standard.';

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

const systemPromptText = buildSystemPrompt();
const approxTokens = Math.ceil(systemPromptText.length / 3.5);
log(`System prompt: ${systemPromptText.length} char (~${approxTokens} token)`);
log(`Prompt caching attivo: prima chiamata ~${approxTokens} token, successive ~${Math.ceil(approxTokens * 0.1)} token`);

const systemPromptCached = [
  { type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral' } },
];

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
  while ((m = filePattern.exec(match[1])) !== null) {
    const filename = m[1];
    // ZERO TRUST: accettiamo SOLO file che esistono nella contentMap (cartella content/).
    // Qualsiasi altro percorso — traversal, dotfiles, file di sistema — viene ignorato.
    if (!contentMap.has(filename)) {
      log(`[CFD-SECURITY-BLOCK] File non in contentMap, bloccato: "${filename}"`);
      continue;
    }
    files.push(filename);
  }
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
  const maxTokens = opts.max_tokens || 12000;
  const useCache = opts.system ? false : true;
  const sys = opts.system
    ? [{ type: 'text', text: opts.system }]
    : systemPromptCached;

  log(`[${requestId}] Chiamata API (${MODEL}, max_tokens=${maxTokens}, cache=${useCache})...`);
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
  const cacheInfo = usage.cache_read_input_tokens
    ? `CACHE HIT ${usage.cache_read_input_tokens} token risparmiati`
    : usage.cache_creation_input_tokens
      ? `CACHE WRITE ${usage.cache_creation_input_tokens} token cachati`
      : 'no cache';
  log(`[${requestId}] API OK (${elapsed}ms) — input: ${usage.input_tokens}, output: ${usage.output_tokens} [${cacheInfo}]`);
  return text;
}

// ===========================================================================
// 5. USER PROFILING ASINCRONO
// Il profilo è un JSON strutturato pre-digerito dall'LLM, salvato nel cookie
// del client. L'LLM di rendering lo riceve già pronto (zero ragionamento).
// L'aggiornamento del profilo avviene in background dopo ogni render.
// ===========================================================================

function profileToPromptContext(profile) {
  if (!profile) return '';

  let ctx = '\n\n--- PROFILO UTENTE (usa queste informazioni per personalizzare layout, tono e contenuti) ---\n';

  // Info base
  if (profile.summary) ctx += `Chi è: ${profile.summary}\n`;
  if (profile.interests?.length) ctx += `Interessi: ${profile.interests.join(', ')}\n`;
  if (profile.goal) ctx += `Obiettivo: ${profile.goal}\n`;
  if (profile.tone_preference) ctx += `Tono preferito: ${profile.tone_preference}\n`;

  // Istruzioni di layout dirette (la parte più importante)
  if (profile.ux_hints) {
    ctx += '\nISTRUZIONI LAYOUT:\n';
    if (profile.ux_hints.emphasize?.length) {
      ctx += `→ ENFATIZZA queste sezioni (in alto, più grandi): ${profile.ux_hints.emphasize.join(', ')}\n`;
    }
    if (profile.ux_hints.deemphasize?.length) {
      ctx += `→ RIDUCI queste sezioni (in basso, più compatte): ${profile.ux_hints.deemphasize.join(', ')}\n`;
    }
    if (profile.ux_hints.preferred_cta) {
      ctx += `→ CTA principale suggerita: "${profile.ux_hints.preferred_cta}"\n`;
    }
  }

  // Comportamento
  if (profile.behavior) {
    if (profile.behavior.after_product) {
      ctx += `→ Dopo un prodotto, l'utente tende a cercare: ${profile.behavior.after_product}\n`;
    }
    if (profile.behavior.detail_level) {
      ctx += `→ Livello di dettaglio preferito: ${profile.behavior.detail_level}\n`;
    }
  }

  ctx += '--- FINE PROFILO ---';
  return ctx;
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
    enrichUser += `Profilo utente: ${userProfile.summary || ''}\n`;
    if (userProfile.interests?.length) enrichUser += `Interessi: ${userProfile.interests.join(', ')}\n`;
    if (userProfile.goal) enrichUser += `Obiettivo: ${userProfile.goal}\n`;
    if (userProfile.tone_preference) enrichUser += `Tono: ${userProfile.tone_preference}\n`;
    enrichUser += 'Adatta il tono e il focus dei testi creativi a questo profilo.\n\n';
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
      try { return JSON.parse(jsonMatch[0]); } catch { }
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
    // Basic Anti-CSRF / API Abuse Protection:
    // Assicuriamoci che la richiesta API provenga solo dal caricamento della nostra stessa pagina (front-end)
    // e non da script cross-site o chiamate decostruite postman-style scoperte (richiede browser veri)
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') {
      log(`[${requestId}] BLOCCO CSRF: Richiesta da origine non consentita (${fetchSite})`);
      return res.status(403).json({ error: 'Accesso negato: Cross-Site Request bloccata' });
    }

    let { intent, profile } = req.body;

    logSep(`${requestId} — Nuova richiesta`);

    // Taglio dell'input per limitare Prompt Injection chilometriche e ridurre l'uso di token malevolo
    // L'intent medio è di 3-4 parole. 1500 caratteri sono già un limite abbondante.
    if (typeof intent === 'string' && intent.length > 1500) {
      log(`[${requestId}] ATTENZIONE: Intent troppo lungo, troncato da ${intent.length} a 1500 char.`);
      intent = intent.substring(0, 1500);
    }

    log(`[${requestId}] Intent: "${intent}"`);
    log(`[${requestId}] Modello: ${MODEL}`);

    // Profilo utente: arriva dal cookie del client, già strutturato dall'LLM
    let userProfile = (profile && typeof profile === 'object') ? profile : null;

    // Anti-intrusion: throttling progressivo basato su tentativi sospetti
    const suspiciousAttempts = userProfile?.suspicious_attempts || 0;
    let maxTokensOverride = null;

    if (suspiciousAttempts >= 5) {
      // Utente ripetutamente sospetto → risposte ultra-corte e generiche
      maxTokensOverride = 500;
      log(`[${requestId}] ⚠️ UTENTE SOSPETTO (${suspiciousAttempts} tentativi) → max_tokens limitato a 500`);
    } else if (suspiciousAttempts >= 3) {
      // Qualche tentativo → riduci capacità
      maxTokensOverride = 2000;
      log(`[${requestId}] ℹ️ Utente con ${suspiciousAttempts} tentativi sospetti → max_tokens ridotto a 2000`);
    }

    if (userProfile) {
      log(`[${requestId}] 👤 PROFILO RICEVUTO:`);
      log(`[${requestId}]   ${JSON.stringify(userProfile)}`);
    } else {
      log(`[${requestId}] 👤 Nessun profilo (prima visita)`);
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

      const reply = await callClaude(messages, requestId, maxTokensOverride ? { max_tokens: maxTokensOverride } : {});
      const requestedFiles = parseCFD(reply);

      if (!requestedFiles) {
        const html = stripCodeFence(reply);
        const totalMs = Date.now() - requestStart;
        log(`[${requestId}] HTML finale (${html.length} char)`);
        log(`[${requestId}] COMPLETATA in ${totalMs}ms (${cycle + 1} chiamate API)`);
        return res.json({ html });
      }

      if (cycle >= MAX_CFD_CYCLES) {
        log(`[${requestId}] Max CFD raggiunto — forzo generazione con contesto disponibile`);
        messages.push({ role: 'assistant', content: reply });
        messages.push({
          role: 'user',
          content: 'Non puoi richiedere altri file. Genera la pagina HTML con il contesto che hai già a disposizione.',
        });
        const forced = await callClaude(messages, requestId, maxTokensOverride ? { max_tokens: maxTokensOverride } : {});
        const html = stripCodeFence(forced);
        const totalMs = Date.now() - requestStart;
        log(`[${requestId}] HTML forzato (${html.length} char)`);
        log(`[${requestId}] COMPLETATA in ${totalMs}ms (${cycle + 2} chiamate API, forzata)`);
        return res.json({ html });
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

// ===========================================================================
// 7. Endpoint POST /api/profile (aggiornamento asincrono del profilo)
// ===========================================================================

let profileCounter = 0;

const PROFILE_SYSTEM_PROMPT =
  'Sei un analista di comportamento utente per un sito web. ' +
  'Ricevi un profilo utente esistente (può essere null se prima visita) e l\'ultima pagina visitata. ' +
  'Devi restituire ESCLUSIVAMENTE un oggetto JSON valido con questa struttura ESATTA:\n\n' +
  '{\n' +
  '  "interests": ["max 5 interessi rilevati dal comportamento"],\n' +
  '  "goal": "obiettivo principale dedotto: acquisto|informazione|esplorazione|ispirazione|confronto",\n' +
  '  "diet_type": "se rilevabile: onnivoro|vegetariano|vegano|senza_glutine|unknown",\n' +
  '  "tone_preference": "tecnico|amichevole|entusiasta|pratico",\n' +
  '  "visited_count": numero_totale_pagine_visitate,\n' +
  '  "last_categories": ["ultime 3 aree tematiche visitate"],\n' +
  '  "summary": "1 frase che descrive questo utente",\n' +
  '  "suspicious_attempts": numero_di_tentativi_sospetti_precedenti,\n' +
  '  "behavior": {\n' +
  '    "after_product": "cosa cerca tipicamente dopo un prodotto: similar_products|recipes|info|buy",\n' +
  '    "browse_style": "explorer (esplora molto) | focused (va dritto al punto) | researcher (approfondisce)",\n' +
  '    "detail_level": "high (legge tutto) | medium | low (scorre veloce)",\n' +
  '    "engagement": "returning (torna spesso) | new (primo contatto) | deepening (sta approfondendo)"\n' +
  '  },\n' +
  '  "ux_hints": {\n' +
  '    "emphasize": ["sezioni da mettere in evidenza nel layout"],\n' +
  '    "deemphasize": ["sezioni da ridurre o nascondere"],\n' +
  '    "preferred_cta": "testo suggerito per il pulsante d\'azione principale"\n' +
  '  },\n' +
  '  "profile_changed": true_o_false\n' +
  '}\n\n' +
  'REGOLE DI ANALISI COMPORTAMENTALE:\n' +
  '- Analizza il PATTERN tra le ultime categorie visitate (es: prodotto→ricetta→prodotto = interesse misto)\n' +
  '- Se l\'utente va da prodotto a ricetta, after_product = "recipes"\n' +
  '- Se l\'utente va da prodotto a prodotto simile, after_product = "similar_products"\n' +
  '- Se l\'utente visita info/about/faq, browse_style = "researcher"\n' +
  '- Se l\'utente visita molte categorie diverse, browse_style = "explorer"\n' +
  '- Se visited_count > 5, engagement = "deepening" o "returning"\n' +
  '- ux_hints.emphasize deve contenere ciò che l\'utente PROBABILMENTE vorrà vedere nella prossima pagina\n' +
  '- ux_hints.deemphasize deve contenere ciò che l\'utente ha già visto o che non gli interessa\n\n' +
  'REGOLA PROFILE_CHANGED:\n' +
  '- profile_changed = true SOLO se interests, behavior, ux_hints o goal sono cambiati rispetto al profilo precedente\n' +
  '- profile_changed = false se hai solo incrementato visited_count o aggiornato last_categories senza cambiare il resto\n' +
  '- Se il profilo precedente è null (prima visita), profile_changed = true\n\n' +
  'Aggiorna il profilo in modo INCREMENTALE: non resettare, evolvi. ' +
  'Se il profilo precedente è null, creane uno nuovo con valori iniziali ragionevoli. ' +
  'Rispondi SOLO con il JSON. Niente altro testo, niente backtick, niente markdown.';

app.post('/api/profile', async (req, res) => {
  const profileId = `PROF-${++profileCounter}`;
  const start = Date.now();

  try {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') {
      return res.status(403).json({ error: 'Accesso negato' });
    }

    const { intent, previous_intent, profile } = req.body;
    if (!intent) {
      return res.status(400).json({ error: 'Campo "intent" obbligatorio' });
    }

    logSep(`${profileId} — Aggiornamento profilo (async)`);
    log(`[${profileId}] Intent: "${intent}"${previous_intent ? ` (precedente: "${previous_intent}")` : ''}`);
    log(`[${profileId}] 📥 PROFILO IN INGRESSO: ${profile ? JSON.stringify(profile) : 'null (prima visita)'}`);

    const transitionInfo = previous_intent
      ? `\nTransizione: "${previous_intent}" → "${intent}" (analizza questo pattern per aggiornare behavior e ux_hints)`
      : '';

    const userMessage = profile
      ? `Profilo attuale:\n${JSON.stringify(profile)}\n\nNuova pagina visitata: "${intent}"${transitionInfo}\n\nAggiorna il profilo.`
      : `Prima visita dell'utente. Pagina visitata: "${intent}"\n\nCrea un profilo iniziale.`;

    const reply = await callClaude(
      [{ role: 'user', content: userMessage }],
      profileId,
      { system: PROFILE_SYSTEM_PROMPT, max_tokens: 300 }
    );

    const cleaned = stripCodeFence(reply);
    let updatedProfile;
    try {
      updatedProfile = JSON.parse(cleaned);
    } catch {
      log(`[${profileId}] ⚠️ Parse JSON profilo fallito, tentativo recupero...`);
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { updatedProfile = JSON.parse(jsonMatch[0]); } catch { }
      }
    }

    if (!updatedProfile) {
      log(`[${profileId}] ❌ Impossibile parsare il profilo, restituisco quello originale`);
      return res.json({ profile: profile || null });
    }

    const elapsed = Date.now() - start;
    const profileChanged = updatedProfile.profile_changed !== false; // default true per sicurezza
    // Rimuovi il flag dal profilo (non serve nel cookie, è solo per il server)
    delete updatedProfile.profile_changed;

    log(`[${profileId}] 📤 PROFILO AGGIORNATO: ${JSON.stringify(updatedProfile)}`);
    log(`[${profileId}] ${profileChanged ? '🔄 CAMBIO SIGNIFICATIVO → cache client verrà invalidata' : '➖ Cambio minimo → cache mantenuta'}`);
    log(`[${profileId}] ✅ Completato in ${elapsed}ms`);

    return res.json({ profile: updatedProfile, profile_changed: profileChanged });
  } catch (err) {
    const elapsed = Date.now() - start;
    log(`[${profileId}] ❌ ERRORE dopo ${elapsed}ms: ${err.message}`);
    console.error('Errore profilo:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// 8. SEO ENGINE — SSR per crawler, Sitemap, Routing semantico
// ===========================================================================

// --- Bot detection ---
const BOT_PATTERNS = [
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
  'yandexbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'whatsapp', 'telegrambot', 'applebot', 'semrushbot', 'ahrefsbot',
  'mj12bot', 'rogerbot', 'embedly', 'quora link preview', 'showyoubot',
  'outbrain', 'pinterest', 'developers.google.com/+/web/snippet',
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_PATTERNS.some(bot => ua.includes(bot));
}

// --- Slug ↔ Intent conversion ---
function intentToSlug(intent) {
  return intent
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuovi accenti
    .replace(/[^a-z0-9\s-]/g, '')                     // rimuovi caratteri speciali
    .trim()
    .replace(/\s+/g, '-')                              // spazi → trattini
    .replace(/-+/g, '-');                               // trattini multipli → singolo
}

function slugToIntent(slug) {
  return decodeURIComponent(slug).replace(/-/g, ' ').trim();
}

// --- SSR Cache (TTL 1 ora) ---
const ssrCache = new Map();
const SSR_CACHE_TTL = 60 * 60 * 1000; // 1 ora

function getCachedSSR(slug) {
  const entry = ssrCache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.ts > SSR_CACHE_TTL) {
    ssrCache.delete(slug);
    return null;
  }
  return entry.html;
}

function setCachedSSR(slug, html) {
  ssrCache.set(slug, { html, ts: Date.now() });
}

// --- SSR HTML wrapper ---
function buildSSRPage(content, title, description, canonicalUrl) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonicalUrl)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta name="robots" content="index, follow">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  <main>${content}</main>
  <footer style="text-align:center;padding:2rem;color:#666;font-size:0.75rem">
    <a href="/">← Torna alla home</a>
  </footer>
</body>
</html>`;
}

// --- Sitemap XML ---
function buildSitemap(baseUrl) {
  const urls = [];

  // Homepage
  urls.push({ loc: baseUrl + '/', priority: '1.0', changefreq: 'daily' });

  // Prodotti dal catalogo
  try {
    const catalog = JSON.parse(contentMap.get('catalog.json') || '{}');
    for (const cat of catalog.categories || []) {
      if (cat.lines) {
        for (const line of cat.lines) {
          for (const p of line.products) {
            const name = `${line.name} ${p.name}`;
            urls.push({
              loc: `${baseUrl}/prodotti/${intentToSlug(name)}`,
              priority: p.is_bestseller ? '0.9' : '0.8',
              changefreq: 'weekly',
            });
          }
        }
      } else {
        for (const p of cat.products || []) {
          urls.push({
            loc: `${baseUrl}/prodotti/${intentToSlug(p.name)}`,
            priority: p.is_bestseller ? '0.9' : '0.8',
            changefreq: 'weekly',
          });
        }
      }
    }
  } catch { }

  // Ricette
  for (const key of contentMap.keys()) {
    if (key.startsWith('recipes/') && key !== 'recipes/index.md' && key.endsWith('.md')) {
      const slug = key.replace('recipes/', '').replace('.md', '');
      urls.push({
        loc: `${baseUrl}/ricette/${slug}`,
        priority: '0.7',
        changefreq: 'monthly',
      });
    }
  }

  // Brand pages
  urls.push({ loc: `${baseUrl}/chi-siamo`, priority: '0.6', changefreq: 'monthly' });
  urls.push({ loc: `${baseUrl}/faq`, priority: '0.5', changefreq: 'monthly' });
  urls.push({ loc: `${baseUrl}/mission`, priority: '0.5', changefreq: 'monthly' });
  urls.push({ loc: `${baseUrl}/catalogo`, priority: '0.9', changefreq: 'weekly' });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return xml;
}

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.set('Content-Type', 'application/xml');
  res.send(buildSitemap(baseUrl));
});

// --- Catch-all route: SSR per bot, SPA fallback per utenti ---
let ssrCounter = 0;

// Pattern URL pericolosi — vengono bloccati PRIMA di arrivare all'LLM
const BLOCKED_URL_PATTERNS = [
  // Admin & auth
  'admin', 'login', 'signin', 'signup', 'register', 'auth',
  'dashboard', 'panel', 'console', 'terminal',
  // CRUD & form
  'edit', 'delete', 'remove', 'insert', 'update', 'modify',
  'nuovo', 'nuova', 'crea', 'aggiungi', 'gestione', 'gestisci', 'manage',
  'form', 'submit', 'save', 'salva',
  // Config & dev
  'config', 'settings', 'preferences', 'options',
  'debug', 'test', 'dev', 'staging',
  // API & data
  'api', 'graphql', 'webhook',
  'upload', 'download', 'export', 'import',
  'database', 'sql', 'query', 'backup',
  // Credenziali
  'password', 'token', 'secret', 'key', 'credential',
  // File system
  '.env', 'server.js', 'node_modules', 'package.json',
  // Legacy
  'wp-admin', 'wp-login', 'phpmyadmin', 'cpanel',
  // Business riservato
  'partnership', 'fornitor', 'inventario', 'stock', 'fattur',
  'contratt', 'margin', 'costi-produzione', 'interno',
];

function isBlockedURL(urlPath) {
  const lower = urlPath.toLowerCase();
  return BLOCKED_URL_PATTERNS.some(p => lower.includes(p));
}

app.get('*', async (req, res) => {
  // Non intercettare file statici (hanno estensione)
  if (path.extname(req.path)) return res.status(404).send('Not found');

  // Blocca URL che tentano di accedere a funzionalità admin/pericolose
  if (isBlockedURL(req.path)) {
    log(`[SECURITY] URL bloccato: ${req.path}`);
    return res.status(404).send('Not found');
  }

  const ua = req.get('user-agent') || '';

  // Se NON è un bot → servi la SPA shell, il client-side JS gestirà il routing
  if (!isBot(ua)) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  // --- SSR per crawler ---
  const ssrId = `SSR-${++ssrCounter}`;
  const reqPath = req.path;

  logSep(`${ssrId} — SSR per crawler`);
  log(`[${ssrId}] Path: ${reqPath}`);
  log(`[${ssrId}] Bot: ${ua.slice(0, 80)}`);

  // Check cache
  const cached = getCachedSSR(reqPath);
  if (cached) {
    log(`[${ssrId}] ✅ Cache HIT — servita pagina cachata`);
    return res.send(cached);
  }

  // Converti path in intent
  let intent;
  if (reqPath === '/' || reqPath === '') {
    intent = 'homepage catalogo completo';
  } else {
    // Rimuovi prefissi noti e converti in intent
    const cleanPath = reqPath
      .replace(/^\/prodotti\//, '')
      .replace(/^\/ricette\//, 'ricetta ')
      .replace(/^\//, '');
    intent = slugToIntent(cleanPath);
  }

  log(`[${ssrId}] Intent dedotto: "${intent}"`);

  try {
    // Genera la pagina via LLM (senza profilo — pagina neutra per SEO)
    const seoSystemPrompt =
      'Sei il motore di rendering SSR di un sito web. Genera HTML per una pagina che verrà indicizzata da Google.\n' +
      'REGOLE:\n' +
      '1. Genera SOLO il contenuto HTML (no <html>, <head>, <body> — vengono aggiunti dal server)\n' +
      '2. Usa classi Tailwind CSS\n' +
      '3. Il contenuto deve essere ricco di testo semantico per SEO (headings, paragrafi, liste)\n' +
      '4. Includi link interni con data-navigate per la navigazione\n' +
      '5. NON generare pagine minimal: il contenuto deve essere sostanzioso\n' +
      '6. Alla fine del tuo HTML, aggiungi un commento HTML con questo formato ESATTO:\n' +
      '<!-- SEO:{"title":"Titolo pagina ottimizzato SEO, max 60 char","description":"Meta description accattivante, max 155 char"} -->';

    const messages = [{ role: 'user', content: intent }];

    // Usa il system prompt cachato + contesto SEO
    const reply = await callClaude(messages, ssrId, {
      system: systemPromptText + '\n\n' + seoSystemPrompt,
      max_tokens: 8000,
    });

    let html = stripCodeFence(reply);

    // Estrai meta tag SEO dal commento HTML
    let title = intent.charAt(0).toUpperCase() + intent.slice(1);
    let description = `Scopri ${intent} sul nostro sito.`;

    const seoMatch = html.match(/<!--\s*SEO:\s*({[^}]+})\s*-->/);
    if (seoMatch) {
      try {
        const seo = JSON.parse(seoMatch[1]);
        if (seo.title) title = seo.title;
        if (seo.description) description = seo.description;
      } catch { }
      // Rimuovi il commento SEO dall'HTML visibile
      html = html.replace(/<!--\s*SEO:\s*{[^}]+}\s*-->/, '');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const canonicalUrl = `${baseUrl}${reqPath}`;
    const fullPage = buildSSRPage(html, title, description, canonicalUrl);

    // Cacha la pagina SSR
    setCachedSSR(reqPath, fullPage);

    log(`[${ssrId}] ✅ Pagina SSR generata (${fullPage.length} char) — title: "${title}"`);
    return res.send(fullPage);
  } catch (err) {
    log(`[${ssrId}] ❌ SSR ERRORE: ${err.message}`);
    // Fallback: servi la SPA
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ---------------------------------------------------------------------------
// 9. Avvio
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DPG Nutrition RTR attivo su http://localhost:${PORT}`);
  console.log(`Modello: ${MODEL}`);
  console.log(`Prodotti in catalogo: ${productLookup.size}`);
  if (DEBUG) console.log('Debug logging ATTIVO');
});
