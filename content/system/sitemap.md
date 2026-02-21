# Guida Contesto — DPG Nutrition RTR System

Questo file elenca tutti i file di contenuto disponibili e il tipo di informazioni che contengono. L'LLM usa questa guida per decidere quali file richiedere via CFD in base all'intenzione dell'utente.

---

## File sempre disponibili (nel system prompt)

| File | Contenuto |
|---|---|
| catalog.json | Indice di tutti i prodotti: nomi, prezzi, categorie, bestseller, file di dettaglio |

---

## File brand

| File | Contenuto |
|---|---|
| brand/about.md | Storia aziendale, fondatori, numeri, contatti, sede |
| brand/mission.md | Mission, valori, impegni, protocollo 3P |
| brand/faq.md | Domande frequenti su ordini, prodotti, nutrizione, azienda |

---

## File prodotto (dettaglio)

| File | Prodotto |
|---|---|
| products/bars-classic.md | Overview linea ProBar Classic (tutti i gusti, confronto con Plant) |
| products/bars-vegan.md | Overview linea ProBar Plant (tutti i gusti, info proteine vegetali) |
| products/bar-c-001.json | ProBar Classic Cioccolato Fondente |
| products/bar-c-002.json | ProBar Classic Nocciola Crunch |
| products/bar-c-003.json | ProBar Classic Cocco & Mandorla |
| products/bar-v-001.json | ProBar Plant Cacao & Datteri |
| products/bar-v-002.json | ProBar Plant Pistacchio & Limone |
| products/flr-001.json | Farina d'Avena Proteica |
| products/flr-002.json | Farina di Riso Integrale |
| products/flr-003.json | Farina Multicereali Sport |
| products/spr-001.json | Crema di Arachidi Smooth |
| products/spr-002.json | Crema di Arachidi Crunchy |
| products/spr-003.json | Crema di Mandorle |

---

## File ricette

| File | Contenuto |
|---|---|
| recipes/index.md | Indice ricette con prodotti usati e tempi |
| recipes/pancake-proteico.md | Pancake al cacao con farina DPG e crema |
| recipes/energy-balls.md | Energy balls no-cook con farina e crema |
| recipes/overnight-oats.md | Overnight oats con varianti stagionali |
| recipes/banana-bread.md | Banana bread proteico con varianti |

**Nota**: le ricette nei file sono esempi. L'LLM può inventare ricette completamente nuove purché usino prodotti DPG reali con dati corretti.

---

## File di sistema

| File | Contenuto |
|---|---|
| system/brand-guidelines.md | Colori, font, tono di voce, stile visivo |
| system/interaction-rules.md | Regole CFD, formato HTML, navigazione, vincoli |
| system/sitemap.md | Questo file — guida ai contenuti disponibili |
