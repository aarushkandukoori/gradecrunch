# GradeCrunch

**All your CMU grades and your QPA, in one place.**

GradeCrunch pulls your scores from Canvas, Gradescope and Autolab, merges them per class, lets you fix the
category weights from the syllabus, shows what you need on the rest of the semester for each letter grade, and
computes your semester QPA (weighted by units), your projected cumulative QPA and a Dean's List check.

**Live: https://gradecrunch.pages.dev**

> An independent student project. Not affiliated with or endorsed by Carnegie Mellon University, Instructure
> (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record is in SIO.

## How to use it

1. Open the site and drag the **Sync grades** button to your bookmarks bar.
2. Open Canvas, log in like usual, click **Sync grades**. You land back on GradeCrunch with your grades.
3. Do the same on Gradescope (and on Autolab if you have classes there).

Re-click the button any time you want fresh numbers.

## Privacy, in one minute

- **No accounts, no server code, no database, no analytics, no third-party scripts.** The site is static files.
  Your grades are saved only in your own browser (localStorage). Delete them any time from Settings.
- **The Sync button is a bookmarklet.** It runs inside the Canvas / Gradescope / Autolab tab you are already logged
  into, reads your own grades there (Canvas through its official REST API; Gradescope and Autolab by reading the
  same pages you would open, one at a time), and sends them to GradeCrunch in the URL fragment (`#sync=...`).
  Browsers never send the fragment to any server, and the app removes it from the address bar right away.
- **No passwords, no tokens.** GradeCrunch never asks for your Andrew password (CMU policy forbids sharing it) or a
  Canvas access token (Canvas's API policy forbids apps collecting them).

## How it works

```
canvas.cmu.edu  ─┐   Sync bookmarklet, running in your        ┌─────────────────────────────────┐
gradescope.com  ─┼─▶ logged-in tab, reads YOUR grades ──────▶ │ gradecrunch.pages.dev (static)  │
autolab (beta)  ─┘   data travels in the URL #fragment        │ merge -> grade math -> QPA      │
                                                              │ saved in your browser only      │
                                                              └─────────────────────────────────┘
```

| Folder / file | What lives there |
|---|---|
| `bookmarklet/` | The Sync button (bundled into one script by `scripts/build-bookmarklet.mjs`) |
| `src/sync/` | Readers for Canvas (REST API), Gradescope and Autolab (course pages) |
| `src/lib/payload.ts` | Packs a sync into the URL fragment and strictly validates what comes back |
| `src/lib/merge.ts` | Joins Canvas + Gradescope + Autolab per course and applies your edits |
| `src/lib/grade.ts` | Grade math that matches Canvas (weights, drop rules, extra credit) and "what do I need" |
| `src/lib/qpa.ts`, `src/lib/cmu.ts` | CMU rules: A/B/C/D/R, units, pass/fail, grad +/- scale, Dean's List by college |
| `src/data/units.json` | Units and titles for ~8,700 CMU courses (from the Schedule of Classes) |
| `src/ui/` | The React interface |

The grade math was checked against Canvas's own numbers on real courses: same percent to two decimals.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests
npm run build    # production build in dist/
```

Deploy (Cloudflare Pages, static):

```bash
./scripts/deploy.sh
```

## License

MIT
