# Bet Coach

Track your bets, see why they hit or missed, and find your leaks. This is a web app you install from your browser: it gets its own icon, opens full screen, and works offline. No app store needed.

---

## 1. Put it online (free, about 10 minutes)

An installable web app has to be served over HTTPS. GitHub Pages does that for free.

1. Make a GitHub account if you don't have one.
2. Create a new repository called `bet-coach`. Set it to **Public** (free Pages needs public; your bets are **not** in the repo, they stay on your device).
3. Upload every file in this folder to the repo (drag them into "Add file → Upload files"), then commit.
4. Go to **Settings → Pages**. Under "Build and deployment", pick **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
5. Wait a minute. Your app is live at `https://YOUR-USERNAME.github.io/bet-coach/`.

## 2. Install it

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open in Chrome → tap **Install app** (or the ⋮ menu → Install app).
- **Computer:** open in Chrome or Edge → click the install icon in the address bar, or the **Install app** button in the app.

## 3. Move your bets over

1. In the Bet Coach page in Claude, tap **Export backup** (under Bankroll line) and save the file.
2. In the app, go to **Settings → Import backup** and pick that file.

Import adds bets and never deletes any, so importing the same file twice is safe.

**Your data lives on the device you use.** Your phone and laptop don't sync. Use Export/Import to move bets between them, and export a backup every week or so. If you delete the app or clear your browser data, unexported bets are gone.

## 4. The AI coach

Two ways to use it:

- **No setup (free with your Claude plan):** tap a coach button and the app gives you a ready-made prompt. Copy it, paste it into claude.ai, then paste Claude's answer back in and save it to the ticket.
- **Answers inside the app:** get an API key at console.anthropic.com, add a few dollars of credit, and paste the key into **Settings**. Each bet breakdown costs a few cents. **Set a monthly spend limit in the console** so it can never surprise you. The key is stored only on that device.

If a model name ever stops working, put a current one in **Settings → Model**.

---

## How the code is laid out

| File | What's in it |
|---|---|
| `index.html` | The page structure: panels, the slip form, Settings. Change labels and layout here. |
| `styles.css` | All the looks. Colors and fonts are variables at the top (`--accent`, `--win`, etc.). |
| `teams.js` | Team lists for the team search on player picks. |
| `app.js` | All the logic, split into sections (search for the `/* ----------` comments). |
| `sw.js` | Offline support. Bump `VERSION` when you publish changes. |
| `manifest.webmanifest` | App name, icon, colors used when it's installed. |

### Sections in app.js

| Section | What it does |
|---|---|
| top (`MARKETS`, `FILTERS`) | Bet types/sections and the filter chips on your book |
| `state` | Everything the app is currently holding in memory |
| `odds math` | Odds ↔ payout conversion, implied probability, profit per bet (`pl`) |
| `watch-outs` | Matching your saved notes to new picks (`warningsFor`, `statMatch`) |
| `stats` | Record, ROI, break-even (`compute`), and the leak flags (`flags`) |
| `render: …` | Turns data into HTML: the scoreboard, chart, tickets |
| `slip: sections & picks` | The Log a bet form, pick rows, team search, auto odds |
| `storage` | Saving/loading from the device (`localSave`, `localLoad`) |
| `examples` | The 4 example bets |
| `ticket actions & notes` | Won/Lost/Cash out buttons, Add note, delete |
| `coach (Claude)` | The coach's instructions (`COACH`) and the prompts it sends |
| `coach engine` | The API call, and the copy-to-Claude panel |
| `settings, backup` | API key, export, import |

---

## Making changes

### The loop

1. Edit a file on your computer.
2. Test it locally. In this folder, run:
   ```
   python -m http.server 8000
   ```
   then open `http://localhost:8000`. (Opening `index.html` directly also mostly works, but offline mode and saving only work through a server.)
3. When it works, open `sw.js` and bump `VERSION` (`"v1"` → `"v2"`).
4. Upload the changed files to GitHub. The live app updates within a minute or two; close and reopen it on your phone to pick it up.

Local testing uses a different saved-data spot than your installed app, so you can't mess up your real bets while testing.

### Common edits

**Add a sport to the dropdown:** in `index.html`, find `<datalist id="sports">` and add `<option>WNBA</option>`.

**Add a team:** in `teams.js`, add `|Team Name` to the right list.

**Add a league to team search:** in `teams.js`, add a new key like `WNBA:"Las Vegas Aces|New York Liberty|…"`. Then in `app.js`, find `function teamPool` and add `/WNBA/.test(s)?"WNBA" :` before the NBA check.

**Change colors:** in `styles.css`, edit the variables at the top. The first block is light mode; the two blocks below it are dark mode, so change both.

**Add a bet type/section:** in `app.js`, add it to `MARKETS`, give it a plural name in `PLURAL`, and an example in `placeholderFor`.

**Teach watch-outs a new stat abbreviation:** in `app.js`, add to `STAT_ALIASES`, e.g. `["turnover","to"]`.

**Change what the coach focuses on:** edit the `COACH` text in `app.js`. It's plain English instructions.

**Add a new leak flag:** in `app.js`, inside `function flags`, add an `out.push({t:"bad", h:"Headline", d:"Explanation"})`. `t` can be `"good"`, `"warn"` or `"bad"`.

### Asking Claude to help edit

Send Claude the file (or just the section) and say what you want, like: *"Here's app.js. Add a filter for player props only."* Ask for the exact lines to change and where they go. After you paste changes in, test locally before uploading.

If something breaks: open the browser dev tools (F12 on a computer → Console tab) and copy the red error message to Claude.
