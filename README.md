# GradeCrunch

**All your CMU grades and your QPA, in one place.**

GradeCrunch pulls your scores from Canvas, Gradescope and Autolab, merges them per class, and shows your semester
QPA (weighted by units). Tap a class to see what you need on the rest of the semester, try what-if scores, or fix
the category weights from the syllabus.

**Live: https://grades.aarushkandukoori.com** (the original https://gradecrunch.pages.dev forwards there)

> An independent student project. Not affiliated with or endorsed by Carnegie Mellon University, Instructure
> (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record is in SIO.

## How to use it

**With the Chrome extension (no setup):** add GradeCrunch to Chrome, click Continue, and the site shows your grades.
If you are not logged in to Canvas or Gradescope, it gives you a link to log in the usual CMU way, then syncs again
when you come back. *(Chrome Web Store listing pending review.)*

**Without the extension:** drag the **Sync grades** button from the site to your bookmarks bar, then click it while
you are on Canvas, then on Gradescope.

## Privacy, in one minute

- **No accounts, no server code, no database, no analytics, no third-party scripts.** The site is static files.
  Your grades are saved only in your own browser. Delete them any time from Settings.
- **GradeCrunch reads only your own grades, inside your own browser,** using the logins you already have: Canvas
  through its official REST API, Gradescope and Autolab by reading the same pages you would open (one at a time).
- **The extension** can talk only to this site (Chrome enforces that), keeps nothing on any server, and asks for the
  minimum: access to canvas.cmu.edu, www.gradescope.com and autolab.andrew.cmu.edu, plus storage.
- **The Sync button** opens GradeCrunch in a new tab and hands your grades over tab to tab (postMessage, checked
  against the exact sites), so they never sit in a URL. Only if a popup blocker stops the new tab does it fall back
  to a `#sync=` link.
- **No passwords, no tokens.** GradeCrunch never asks for your Andrew password (CMU policy forbids sharing it) or a
  Canvas access token (Canvas's API policy forbids apps collecting them).

## How it works

```
canvas.cmu.edu  ─┐   Chrome extension (or the Sync button),          ┌─────────────────────────────┐
gradescope.com  ─┼─▶ running with YOUR logins, reads YOUR grades ──▶ │ grades.aarushkandukoori.com │
autolab (beta)  ─┘   handed straight to the site in your browser     │ merge -> grade math -> QPA  │
                                                                     │ saved in your browser only  │
                                                                     └─────────────────────────────┘
```

| Folder / file | What lives there |
|---|---|
| `extension/` | The Chrome extension (Manifest V3): service worker, offscreen sync page, first-run welcome page |
| `extension/protocol.ts` | The messages the site and the extension exchange |
| `bookmarklet/` | The Sync button (bundled into one script by `scripts/build-bookmarklet.mjs`) |
| `src/sync/` | Readers for Canvas (REST API), Gradescope and Autolab (course pages), shared by both |
| `src/lib/payload.ts` | Strictly validates any grades that arrive from outside the page |
| `src/lib/merge.ts` | Joins Canvas + Gradescope + Autolab per course and applies your edits |
| `src/lib/grade.ts` | Grade math that matches Canvas (weights, drop rules, extra credit) and "what do I need" |
| `src/lib/qpa.ts`, `src/lib/cmu.ts` | CMU rules: A/B/C/D/R, units, pass/fail, grad +/- scale, Dean's List by college |
| `src/data/units.json` | Units and titles for ~8,700 CMU courses (from the Schedule of Classes) |
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

To try the extension locally: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick
`dist-extension/`.

Deploy the site (Cloudflare Pages, static):

```bash
./scripts/deploy.sh
```

## License

MIT
