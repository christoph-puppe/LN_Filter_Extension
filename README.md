# LN Filter — LinkedIn Feed Re-Ranker

Eine Chrome-Extension, die deinen LinkedIn-Feed mit **Gemini 3 Flash** nach deinen eigenen Vorgaben bewertet und neu sortiert / filtert. Lokal, kein Backend.

## Was sie tut

- Scannt jeden Beitrag im LinkedIn-Feed
- Bewertet ihn 0–100 nach deinen **Interessen**, **Dislikes** und **Kategorien-Gewichten**
- Hybrid-Strategie: sichtbare Beiträge zuerst, danach Vorab-Bulk für die nächsten N
- Drei Modi: **Aus** · **Dim** (gedämpft anzeigen) · **Hide** (ausblenden)
- Sortiert den Feed optional nach Score absteigend → echter Algo-Ersatz
- Score-Badge auf jedem Post mit Hover-Tooltip (Kategorie + Kurzbegründung)
- Cache (24h default), damit Refresh nichts erneut bewertet
- Floating Overlay direkt auf LinkedIn für schnelles Toggling

## Installation

1. Diesen Ordner irgendwo lokal liegen lassen.
2. Chrome → `chrome://extensions` → **Entwicklermodus** oben rechts aktivieren.
3. **„Entpackte Erweiterung laden"** → diesen Ordner auswählen.
4. Auf das Puzzle-Icon in der Toolbar → LN Filter anpinnen.
5. Klick auf das Icon → **Optionen** → **Gemini API-Key** einfügen.
   Kostenloser Key: https://aistudio.google.com/apikey
6. LinkedIn öffnen (`https://www.linkedin.com/feed/`) — das Overlay erscheint unten rechts.

## Bedienung

**Im Popup (Toolbar-Icon):** Modus, Schwelle, Sortierung, „Neu bewerten", Link zu Optionen.

**Im Overlay auf LinkedIn:** dieselben Quick-Controls + Live-Status (bewertet / offen).

**In den Optionen:**
- **Model & API:** Key + Gemini-Variante. Default `gemini-3-flash-preview` (kostenlos im Free-Tier, schnell genug, gut genug).
- **Interessen & Dislikes:** Freitext, je konkreter desto besser. Werden in den Prompt als `{interests}` / `{dislikes}` eingesetzt.
- **Kategorien:** 16 Buckets mit Gewicht 0–100. Der Prompt zwingt das Model, eine davon zu wählen.
- **Prompt:** kompletter Bewertungs-Prompt als Textarea, mit Reset-Knopf und Platzhalter-Validierung. Edit auf eigenes Risiko.
- **Performance & Cache:** Concurrency (Default 4), Thinking-Level (`low` empfohlen für Bulk), Retries, Bulk-Lookahead, Cache-TTL, Default-Schwelle.

## Architektur

```
manifest.json              MV3
background/service-worker  Gemini-Calls mit Pool + Retries + Score-Cache
content/feed.js            MutationObserver + IntersectionObserver, Badge & Sort
content/overlay.css        Badge + Floating-Widget Styles
popup/                     Quick-Controls
options/                   Vollständige Settings, Glassmorphic Deep Design
shared/defaults.js         Default-Prompts, Default-Settings, Score-Schema
shared/gemini.js           Gemini API-Wrapper mit `extractJson` + runPool
shared/storage.js          chrome.storage Helper + Score-Cache (FNV-1a hash)
icons/                     16 / 48 / 128 PNG
```

Posts werden über `data-urn`-Attribut identifiziert (stabil), Fallback per Text-Hash. Sortierung läuft über CSS `order` auf einem flex-column gemachten Feed-Container — keine DOM-Manipulation, kein Layout-Thrash.

## Bekannte Einschränkungen

- LinkedIn renennt Klassen regelmäßig. Wenn nichts mehr passiert: in `content/feed.js` die `POST_SELECTORS` / `TEXT_SELECTORS` / `AUTHOR_SELECTORS` checken.
- Reposts (Beiträge, die andere geteilt haben) werden anhand des äußeren Wrappers bewertet — der innere Original-Post-Text wird mitgenommen, der Repost-Kommentar ist Teil davon.
- Sponsored / Promoted Posts werden nicht gesondert behandelt (laufen über das normale Scoring; landen wegen „promo"-Kategorie meist auf niedrigem Score und werden gefiltert).
- Bilder / Videos werden nicht analysiert — nur Text + Author.
- Bei 429 Rate-Limit: Concurrency runter, Cache greift bei Refresh.

## Datenschutz

- API-Key liegt ausschließlich in `chrome.storage.local` deines Browsers.
- Post-Texte + Author werden für den Bewertungs-Call an Gemini gesendet — sonst nirgendwo.
- Keine Telemetrie. Keine Server-Komponente. Quellcode komplett lesbar.

## Tweaking

Der Prompt ist der wichtigste Hebel. Die Default-Version optimiert auf Tech-Substanz; für andere Profile in den Optionen umschreiben (Reset-Knopf bringt das Default jederzeit zurück).

Für sehr restriktive Filter: Schwelle auf 60–70 + Modus „Hide". Für entspannten Überblick: Schwelle 35 + Modus „Dim" + Sortierung an.

## Debugging

In der DevTools-Console auf `linkedin.com`:

- `__lnfDiag()` — zeigt was die Extension gerade sieht: Feed-Container gefunden? Wie viele Kids, wie viele mit Text-Box, wie viele getrackt, Counters, letzter Error.
- `__lnfDisable()` — Panic-Switch: entfernt alle DOM-Modifikationen und stoppt den Scanner.

Wenn LinkedIn seine Selektoren ändert und Posts nicht mehr erkannt werden, gibt `__lnfDiag()` die Antwort innerhalb von 5 Sekunden:

- `feed found? false` → der `[data-testid="mainFeed"]`-Marker existiert nicht mehr. Neuen Selektor in `content/feed.js` (`FEED_SELECTOR`) suchen.
- `kids w/ text box: 0` → der `[data-testid="expandable-text-box"]`-Marker ist weg. Neuen Text-Marker in `TEXT_SELECTOR` setzen.
- `findReturned > 0` aber `registerEmpty > 0` → `extractText`/`extractAuthor` finden nichts mehr — Autor-Selektoren prüfen.

## Lizenz

Apache 2.0 — siehe [LICENSE](LICENSE).
