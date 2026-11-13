# GradeCrunch

**All your CMU grades and your QPA, in one place.**

GradeCrunch pulls your scores from Canvas, Gradescope and Autolab, merges them per class, and shows your semester
QPA (weighted by units). From SIO, CMU's official record, it takes your exact units, which classes are pass/fail,
mid-semester and final grades, and your past semesters with the official cumulative QPA. Tap **P/F** on a class to see
your QPA with it pass/fail. Tap a class to see what you need on the rest of the semester, try what-if scores, or fix
the category weights from the syllabus. The **AI advisor**, an optional AI chat, answers questions about your grades,
fixes settings when you tell it (weights, units, pass/fail) and remembers what you told it.

**Live: https://grades.aarushkandukoori.com** (the original https://gradecrunch.pages.dev forwards there)

> An independent student project. Not affiliated with or endorsed by Carnegie Mellon University, Instructure
> (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record is in SIO.

## How to use it

**With the Chrome extension (no setup):** add GradeCrunch to Chrome, click Continue, and the site shows your grades.
If you are not logged in to Canvas, Gradescope or SIO, it gives you a link to log in the usual CMU way, then syncs
again when you come back. *(Chrome Web Store listing pending review.)*

**Without the extension:** drag the **Sync grades** button from the site to your bookmarks bar, then click it while
you are on Canvas, then on Gradescope, then on SIO.

## Privacy, in one minute

- **No accounts, no database, no analytics, no third-party scripts.** The site is static files plus one small
  server function, only for the AI advisor. Your grades are saved only in your own browser. Delete them any time from
  Settings.
- **GradeCrunch reads only your own grades, inside your own browser,** using the logins you already have: Canvas
  through its official REST API, Gradescope, Autolab and SIO by reading the same pages you would open (one at a
  time). On SIO that is only the Grades and QPA page. Like everything else, what it reads there is saved only in your
  browser.
- **The AI advisor (optional AI chat)** is the one thing that leaves your browser. Only when you use it, your
  question, the recent chat, the advisor's notes about you and a summary of your grades (no name, no links, no
  syllabus text) go through `/api/chat` to OpenAI. GradeCrunch's server stores nothing and logs only error codes.
  OpenAI doesn't train on it and keeps it up to 30 days for abuse checks. The chat and the notes are saved in your
  browser; see or delete the notes in Settings.
- **The extension** can talk only to this site (Chrome enforces that), keeps nothing on any server, and asks for the
  minimum: access to canvas.cmu.edu, www.gradescope.com, autolab.andrew.cmu.edu and s3.andrew.cmu.edu (SIO), plus
  storage.
- **The Sync button** opens GradeCrunch in a new tab and hands your grades over tab to tab (postMessage, checked
  against the exact sites), so they never sit in a URL. Only if a popup blocker stops the new tab does it fall back
  to a `#sync=` link.
- **No passwords, no tokens.** GradeCrunch never asks for your Andrew password (CMU policy forbids sharing it) or a
  Canvas access token (Canvas's API policy forbids apps collecting them).

## How it works

```
canvas.cmu.edu  ─┐   Chrome extension (or the Sync button),          ┌─────────────────────────────┐
gradescope.com  ─┤   running with YOUR logins, reads YOUR grades ──▶ │ grades.aarushkandukoori.com │
autolab (beta)  ─┼─▶ handed straight to the site in your browser     │ merge -> grade math -> QPA  │
SIO (record)    ─┘                                                   │ saved in your browser only  │
                                                                     └──────────────┬──────────────┘
                         only when you use the AI advisor: question + grade summary │
                                                                                    ▼
                                                                     OpenAI ◀── /api/chat (stores nothing)
```

| Folder / file | What lives there |
|---|---|
| `extension/` | The Chrome extension (Manifest V3): service worker, offscreen sync page, first-run welcome page |
| `extension/protocol.ts` | The messages the site and the extension exchange |
| `bookmarklet/` | The Sync button (bundled into one script by `scripts/build-bookmarklet.mjs`) |
| `src/sync/` | Readers for Canvas (REST API), Gradescope and Autolab (course pages) and SIO (Grades and QPA page), shared by both |
| `src/lib/payload.ts` | Strictly validates any grades that arrive from outside the page |
| `src/lib/merge.ts` | Joins Canvas + Gradescope + Autolab per course, lines classes up with SIO, and applies your edits |
| `src/lib/sio.ts` | SIO rules: which semesters are finished, QPA before this semester, the official cumulative |
| `src/lib/grade.ts` | Grade math that matches Canvas (weights, drop rules, extra credit) and "what do I need" |
| `src/lib/qpa.ts`, `src/lib/cmu.ts` | CMU rules: A/B/C/D/R, units, pass/fail, grad +/- scale, Dean's List by college |
| `src/data/units.json` | Units and titles for ~8,700 CMU courses (from the Schedule of Classes) |
| `src/lib/chat/` | The AI advisor: the grade summary it sends, its tools (they change settings in your browser, each with Undo), its notes |
| `functions/api/chat.ts` | The only server code: POST /api/chat, a stateless pass-through to OpenAI for the AI advisor |
| `src/ui/` | The React interface |

The grade math was checked against Canvas's own numbers on real courses: same percent to two decimals.

## Develop

```bash
npm install
npm run dev              # http://localhost:5173
npm test                 # unit tests
npm run build            # site, in dist/
npm run build:extension  # extension: dist-extension/ (load unpacked) and gradecrunch-extension.zip (store)
```

Vite doesn't run the AI advisor function. To try the AI advisor locally: put `OPENAI_API_KEY=...` (and optionally
`OPENAI_MODEL`, or `OPENAI_BASE_URL` for a mock server) in `.dev.vars` (gitignored, never commit it), then
`npm run build` and `npx wrangler pages dev dist`. A wrangler whose local runtime is older than this project's
`compatibility_date` refuses to start (wrangler 4.148 goes up to 2026-10-13): update wrangler, or add
`--compatibility-date 2026-10-13`.

To try the extension locally: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick
`dist-extension/`. After that, raise the version in `extension/manifest.json` with each change and run
`npm run build:extension`. The site (`npm run dev`, or the next deploy) knows the new version, sees the loaded copy is
older and asks it to reload itself. Only the unpacked dev build does; the store build ignores the request.

Deploy the site (Cloudflare Pages: the static files in `dist/` plus the AI advisor function in `functions/`, which
wrangler bundles because the script runs from the project root):

```bash
./scripts/deploy.sh
```

The AI advisor needs the `OPENAI_API_KEY` secret in the Pages project (Settings > Variables and Secrets). Without it,
the AI advisor answers "The AI advisor isn't set up yet."

Keeping the AI advisor's cost capped (anyone can copy the site's Origin header in a script, so the function's own
checks are not enough):
- The function answers only on grades.aarushkandukoori.com (and localhost), never on gradecrunch.pages.dev or a
  deploy's preview address, so a limit on that zone covers it.
- Add a WAF rate limiting rule for `/api/chat` on the grades.aarushkandukoori.com zone in Cloudflare. The function's
  own per-address limit is kept in memory and is only a best effort.
- Use an OpenAI key from a project with a monthly budget and "Enforce a hard limit" turned on (or prepaid credit
  without auto-recharge). A budget alert alone doesn't stop requests. When the limit is reached, the AI advisor says
  "The AI advisor is off for now".

## License

MIT
