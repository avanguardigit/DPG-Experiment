# Brand Guidelines — DPG Nutrition

## Identità

- **Nome**: DPG Nutrition (esteso: Dynamic Performance Growth Nutrition)
- **Tagline**: "Energia vera, ogni giorno."
- **Sempre**: "DPG Nutrition" per esteso. Mai "DPG" da solo.

## Tono di voce

Diretto, amichevole, competente, onesto, accessibile. Come un amico che lavora nel settore e sa quello che dice senza farlo pesare.

✅ "20g di proteine per barretta. Non è magia, è una buona formula."
❌ "La MIGLIORE barretta proteica sul mercato!!! Ordina ORA!"
❌ "Il SUPERFOOD che DEVI aggiungere alla tua dieta!"
❌ "Rivoluziona il tuo corpo con DPG Nutrition!"

## Palette colori (classi Tailwind)

### Primari
| Nome | HEX | Classe Tailwind | Uso |
|---|---|---|---|
| DPG Green | #2D6A4F | `bg-dpg`, `text-dpg` | Colore principale, CTA |
| DPG Dark | #1B4332 | `bg-dpg-dark`, `text-dpg-dark` | Testi, sfondi scuri |
| DPG Light | #D8F3DC | `bg-dpg-light`, `text-dpg-light` | Sfondi chiari, card, highlight |
| DPG Mid | #40916C | `bg-dpg-mid` | Hover CTA |
| DPG Accent | #52B788 | `text-dpg-accent` | Accenti, evidenziazioni |

### Secondari
| Nome | HEX | Classe Tailwind | Uso |
|---|---|---|---|
| Warm White | #FEFAE0 | `bg-warm` | Sfondo pagina |
| Earth Brown | #6B4226 | `text-earth`, `bg-earth` | Accenti caldi |
| Protein Gold | #E9C46A | `bg-gold`, `text-gold` | Badge, bestseller |
| Alert Red | #E63946 | `text-alert`, `bg-alert` | Allergeni, avvisi |

### Accenti categoria
| Categoria | HEX | Classe Tailwind |
|---|---|---|
| Barrette Classic | #5C3D2E | `bg-cat-classic`, `text-cat-classic` |
| Barrette Plant | #40916C | `bg-cat-plant`, `text-cat-plant` |
| Farine | #DDA15E | `bg-cat-flour`, `text-cat-flour` |
| Creme | #BC6C25 | `bg-cat-spread`, `text-cat-spread` |

## Tipografia

Font: Inter (già caricato nella shell). Usa le classi Tailwind:
- **Titoli**: `font-bold` o `font-semibold`, dimensioni `text-4xl` / `text-2xl` / `text-xl`
- **Corpo**: `text-base` (1rem)
- **Small**: `text-sm` (0.875rem)
- **Tracking**: `tracking-tight` per titoli grandi

## Stile visivo

Molto spazio bianco (`py-8`, `py-12`, `gap-6`), informazioni importanti subito visibili, toni caldi per bilanciare il verde. Card: `bg-white rounded-xl p-6 border border-dpg/5` con hover `hover:-translate-y-1 hover:shadow-lg transition-all`. CTA: `bg-dpg text-white rounded-lg font-semibold hover:bg-dpg-mid`. Responsive: usare i prefissi `md:` e `lg:` di Tailwind.

## Placeholder immagini

Nessuna immagine reale. Usare rettangoli colorati con il colore della categoria + emoji:
```html
<div class="bg-cat-classic/10 rounded-lg h-32 flex items-center justify-center text-4xl">🍫</div>
```
Emoji di riferimento: 🍫 barrette, 🌿 vegan, 🥜 arachidi, 🫙 creme, 🌾 farine.
