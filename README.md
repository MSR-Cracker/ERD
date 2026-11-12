# ERDForge — AI-Assisted ERD Design & Visualization Studio

ERDForge is a local-first Entity-Relationship Diagram (ERD) design, review, and export studio built with React 18, strict TypeScript, Vite, Tailwind CSS, Zustand, Dexie (IndexedDB), `@xyflow/react`, ELK.js, Monaco Editor, and Cloudflare Workers.

A new installation opens to a **blank project**—no bundled Pharmacy Chain or other demo schema is injected. Start by describing a database to Gemini, pasting SQL/JSON/DBML, importing a schema file, or adding tables directly on the canvas. The visual editor supports draggable table cards, table-to-table relationship creation, schema review, undo/redo, and SQL/diagram export.

Core capabilities—multi-format parsing, Crow's Foot diagramming, ELK auto-layout, manual editing with two-way DBML synchronization, deterministic 9-rule schema review with one-click fixes, and 13 export formats—run **locally in the browser** without requiring an AI key. Gemini assistance runs through a Cloudflare Worker and returns reviewable schema changes; accepted changes update the normalized model and can be exported as SQL.

## First-Run Workflow

- **Blank by default:** On first launch, ERDForge creates an empty `Untitled project`. The legacy `pharmacy-chain-v1` demo record is removed from local IndexedDB during migration; other saved projects are preserved.
- **Build with AI:** Open **Ask AI** or use **Build with AI** from the empty canvas, then enter a natural-language description or paste a SQL/JSON/DBML schema. Review Gemini's proposed operations before accepting them.
- **Design visually:** Add tables from the canvas toolbar, drag table cards to arrange them, and drag from a table's right connector to another table's left connector to create a relationship.
- **Export:** Use the Export panel to generate SQL DDL or diagram files from the normalized model.

## Architecture Overview

```text
erdforge/
├── src/
│   ├── model/       # Canonical Zod-validated ERD model, atomic patch engine, 9-rule reviewer, .erdforge.json I/O
│   ├── parsers/     # Deterministic SQL, PHP/Laravel/Eloquent, JSON/JSON Schema/OpenAPI, DBML, Mermaid, & Markdown parsers
│   ├── layout/      # ELK.js layered/force/radial auto-layout with orthogonal edge routing & alignment guides
│   ├── exporters/   # Physical relational builder + PNG (2x/4x), SVG, PDF (A4/A3), MySQL/PostgreSQL/SQLite DDL, Laravel, Prisma, DBML, Mermaid, JSON, & Data Dictionary exporters
│   ├── store/       # Zustand command store (undo/redo, patch preview) + Dexie IndexedDB multi-project autosave (50-snapshot cap)
│   ├── ai/          # Client-side SSE streaming caller for /api/parse, /api/ai/patch, and /api/ai/explain
│   ├── i18n/        # Bilingual English (LTR) & Arabic (RTL) localization dictionaries and layout helpers
│   └── ui/          # Memoized Crow's Foot EntityNode, RelationshipEdge, SpecializationEdge, DiagramCanvas, ManualInspector, SchemaReviewPanel, ExportPanel, AIProposalPanel
├── worker/          # Cloudflare Worker serving static assets and /api/health, /api/parse, /api/ai/patch, /api/ai/explain
└── tests/           # Vitest unit/golden/performance suites (11 suites) + Playwright E2E flow
```

### Single Normalized Model & Notation Extension Seam
- **Source of truth**: `SchemaModel` (`src/model/types.ts` & `src/model/schema.ts`) represents strong, weak, and associative entities; simple, composite, multivalued, and derived attributes (with PK/FK/UK/NULL/index/stored flags, defaults, enums, and formulas); relationships (cardinality, total/partial participation, identifying flag, `onDelete`/`onUpdate` rules); ISA specializations (disjoint/overlapping, total/partial); and colored subject areas.
- **Notation renderer adapter (`src/ui/notation.ts`)**: V1 ships **Crow's Foot** (`crow-foot`) behind the `NotationRendererAdapter` interface (`NOTATION_RENDERER_REGISTRY`). Future notations (`chen`, `uml-class`, `idef1x`) are registered as `'planned'` on the shared adapter registry so additional glyph/node renderers can be plugged in without changing the normalized model or layout pipeline.

## Setup & Local Development

### Prerequisites
- Node.js `>= 20.0.0`
- `pnpm` (recommended, `corepack enable && corepack prepare pnpm@9.15.4 --activate`) or `npm`

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Local Environment Variables (`.dev.vars`)
Copy `.dev.vars.example` to `.dev.vars` for local Wrangler Worker development:
```bash
cp .dev.vars.example .dev.vars
```
Edit `.dev.vars` and set your Google AI Studio key if you want to test optional Gemini features locally:
```ini
GEMINI_API_KEY=your_real_gemini_api_key_from_google_ai_studio
GEMINI_MODEL=gemini-2.5-flash
```
> **Note**: `GEMINI_API_KEY` is read exclusively inside the Cloudflare Worker via `env.GEMINI_API_KEY` and is never exposed in client bundles or any `VITE_` variable. If `GEMINI_API_KEY` is omitted, all local features work normally and AI routes return `AI_NOT_CONFIGURED`.

### 3. Run in Development Mode
```bash
# Start Vite dev server (with Cloudflare Worker plugin on port 3000)
pnpm run dev

# Or run the standalone Wrangler Worker dev server after building
pnpm run build && pnpm run dev:worker
```

## Testing & Verification Commands

```bash
# TypeScript strict project-references check (app + worker + node)
pnpm run typecheck

# ESLint check
pnpm run lint

# Run the full Vitest unit, golden exporter, and 120-entity performance suite
pnpm run test

# Run the Playwright end-to-end browser workflow
pnpm run test:e2e

# Production build
pnpm run build
```

## Deploying to Cloudflare Workers

1. Authenticate Wrangler with your Cloudflare account:
   ```bash
   npx wrangler login
   ```
2. Build and deploy the project:
   ```bash
   pnpm run deploy
   ```

## Replace the Placeholder Key

If your deployment was initialized with a placeholder secret (such as `"abc1234"`), the Worker will reject AI requests with:
> `"The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare."`

To replace the placeholder key with a real Google AI Studio key:
- **Cloudflare Dashboard**: Go to **Cloudflare dashboard > Workers & Pages > project > Settings > Variables and Secrets > edit `GEMINI_API_KEY` > paste the real key from Google AI Studio > Save and redeploy**.
- **CLI alternative**:
  ```bash
  npx wrangler secret put GEMINI_API_KEY
  ```

## Gemini Free-Tier Limits & Privacy Notice

- **Free-tier rate & quota limits**: The Cloudflare Worker enforces per-IP rate limiting (via the `AI_RATE_LIMITER` binding or built-in isolate sliding window), a 512 KiB request body cap, a 100,000-character schema source cap, an 8,000-character edit instruction cap, bounded retries on transient `5xx`/`429` responses with `Retry-After` backoff, and a 40-second upstream timeout. When Google AI Studio free-tier rate or daily quota limits (`429 RESOURCE_EXHAUSTED`) are reached, ERDForge surfaces a clear `AI_QUOTA` message without losing any local work.
- **Google free-tier data usage notice**: When using a free-tier Google Gemini API key, **free-tier Gemini inputs and generated outputs may be used by Google to improve its products and may be reviewed by human reviewers**. ERDForge requires explicit user acknowledgement before transmitting any schema text or review finding to Gemini, never logs schemas, prompts, or completions in the Worker (logging only `requestId`, `route`, `status`, and `durationMs`), and never applies AI changes without per-operation user review.
