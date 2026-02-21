# DPG — Dynamic Page Generation

Un esperimento di sito web dove **nessuna pagina esiste tranne la home**. Ogni contenuto viene generato dinamicamente da un LLM (Claude, Anthropic) che riceve solo il contesto strettamente necessario e restituisce HTML completo, iniettato direttamente nel DOM.

Il cuore del sistema è il protocollo **CFD (Context Fetch Directive)**: un meccanismo che permette all'LLM di richiedere al server esattamente i file di cui ha bisogno, evitando di sovraccaricare ogni prompt con tutti i dati disponibili. L'LLM decide autonomamente cosa gli serve, lo chiede, lo riceve, e genera.

Il sito si adatta all'utente: traccia il percorso di navigazione, costruisce un profilo di interessi e personalizza i contenuti generati di conseguenza.

> L'istanza di test usa un'azienda fittizia di nutrizione sportiva (DPG Nutrition) come caso d'uso. Il sistema è progettato per essere riusabile con qualsiasi brand — basta cambiare i file di contenuto e i prompt.

## Come funziona

### Architettura

```
Browser (vanilla HTML/JS + Tailwind CSS)
    │
    ├── Home page statica (istantanea, zero API)
    │
    └── Qualsiasi altro contenuto
            │
            ▼
        POST /api/generate { intent, journey }
            │
            ▼
        Express server
            │
            ├── Detect prodotto? → Template + LLM enrichment (~2-3s)
            │
            └── Pagina libera? → Generazione completa con CFD loop (~10-20s)
                    │
                    ▼
                Claude API (Anthropic)
                    │
                    ├── Risposta CFD? → Server carica file → Richiama LLM con contesto
                    │
                    └── Risposta HTML? → Iniettato nel DOM
```

### Concetti chiave

**Dynamic Page Generation (DPG)** — Non esiste routing, non esistono pagine. C'è solo una shell HTML (header, footer, loader) e un `<div id="content">` dove l'HTML generato viene iniettato. Ogni "pagina" è il risultato di una chiamata LLM. La navigazione è basata su "intent" testuali, non su URL.

**CFD (Context Fetch Directive)** — Il protocollo fondamentale che rende possibile il sistema. Funziona così:

1. Il server invia all'LLM il system prompt con le regole, le brand guidelines e il catalogo prodotti (indice leggero)
2. L'LLM analizza l'intent dell'utente e decide se ha bisogno di dati aggiuntivi
3. Se sì, risponde SOLO con una direttiva: `CFD:"products/bar-c-001.json","recipes/pancake-proteico.md"`
4. Il server carica i file richiesti dalla memoria e li reinvia come contesto
5. L'LLM ora ha esattamente i dati che servono e genera l'HTML

Senza CFD, ci sarebbero due alternative peggiori: (a) mandare tutti i file ad ogni chiamata (troppi token, troppo costoso, troppo lento) oppure (b) il server dovrebbe indovinare quali file servono (fragile, limitato). Il CFD lascia decidere all'LLM, che è chi meglio sa cosa gli serve per generare la pagina richiesta. Il loop CFD è limitato a 3 cicli per evitare loop infiniti.

**Tailwind CSS** — Il framework CSS è caricato via CDN con una configurazione custom di colori del brand. L'LLM genera HTML usando esclusivamente classi Tailwind invece di scrivere CSS custom. Questo ha un impatto diretto sulle performance: una pagina con classi utility richiede ~2000 token di output, la stessa pagina con CSS inline ne richiederebbe ~4000+. Meno token = generazione più veloce = meno costo.

**Template + Enrichment** — Le pagine con struttura prevedibile (es. dettaglio prodotto) usano un sistema ibrido: l'LLM genera il layout una sola volta (primo prodotto) con placeholder marcati. Il server salva quel template e lo riusa per tutti i prodotti successivi, iniettando i dati reali dal JSON e chiedendo all'LLM solo i testi creativi (~300 token). Risultato: primo prodotto ~15s, tutti i successivi ~2-3s.

**Personalizzazione adattiva** — Il client traccia ogni navigazione in un array `journey`. Il server costruisce un profilo utente dal percorso e lo inietta come contesto nel prompt. L'LLM adatta tono, contenuti, link suggeriti e persino le ricette in base agli interessi rilevati (dieta, performance, vegano, ecc.). Più l'utente naviga, più il sito si personalizza.

**Cache client** — Le pagine visitate vengono salvate in una `Map` lato browser. Al secondo accesso lo stesso contenuto appare istantaneamente. La cache si svuota al refresh (by design — così la personalizzazione evolve).

## Setup

```bash
npm install
```

Crea un file `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
DEBUG=true
MODEL=claude-haiku-4-5-20251001
```

Avvia:

```bash
npm start
```

Apri `http://localhost:3000`.

## Configurazione

| Variabile | Descrizione | Default |
|-----------|------------|---------|
| `ANTHROPIC_API_KEY` | API key Anthropic (obbligatoria) | — |
| `PORT` | Porta del server | `3000` |
| `MODEL` | Modello Claude da usare | `claude-haiku-4-5-20251001` |
| `DEBUG` | Log dettagliati nel terminale | `false` |

Modelli consigliati (dal più veloce al più capace):
- `claude-haiku-4-5-20251001` — veloce, economico, buono per HTML
- `claude-sonnet-4-20250514` — più capace, più lento
- `claude-opus-4-6` — massima qualità, molto lento

## Struttura progetto

```
├── server.js           # Express server + template system + profiling
├── public/
│   └── index.html      # Shell unica: header, footer, loader, home statica, JS
├── content/            # Dati e regole (specifici per il brand di test)
│   ├── catalog.json    # Indice prodotti
│   ├── system/         # Regole per l'LLM
│   │   ├── interaction-rules.md
│   │   ├── brand-guidelines.md
│   │   └── sitemap.md
│   ├── products/       # JSON dettaglio prodotti + overview linee
│   ├── brand/          # About, mission, FAQ
│   └── recipes/        # Ricette in markdown
├── .env                # Configurazione (non committato)
└── package.json
```

## Come adattarlo a un altro progetto

Le funzioni nel server sono generiche. Per cambiare brand/sito:

1. **Sostituisci `content/`** con i tuoi dati (prodotti, brand, ricette o qualsiasi contenuto)
2. **Aggiorna i prompt** in `content/system/` (interaction-rules, brand-guidelines, sitemap)
3. **Aggiorna la home** nel `<template>` dentro `index.html`
4. **Aggiorna i colori** nella config Tailwind dentro `index.html`

Non serve toccare `server.js` — le funzioni (CFD, template, profiling, enrichment) funzionano con qualsiasi struttura di contenuti.

## Limiti e note

- La velocità dipende dal modello: Haiku ~5-15s per pagina generativa, Opus ~40-60s
- Le pagine template (prodotti) dopo il primo sono ~2-3s
- La cache si svuota al refresh (by design)
- Il profilo utente vive solo nella sessione browser corrente
- Nessun database, nessun login, nessuna persistenza server-side
- Tailwind CSS caricato via CDN (non per produzione)

## Stack

- **Backend**: Express.js (Node.js 18+)
- **Frontend**: Vanilla HTML/CSS/JS + Tailwind CSS CDN
- **LLM**: Claude via API Anthropic
- **Dipendenze**: solo `express` e `dotenv`
