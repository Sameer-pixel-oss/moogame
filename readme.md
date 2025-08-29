Moo Across — Voice-Jump Cow Game

Play: Allow microphone, shout "Moo" (or any loud sound) to jump across uneven islands. Survive 60 seconds.

Features
- Auto-walking cow, voice-controlled variable jump height (Web Audio API)
- Procedural islands with random gaps and heights
- At least 10 obstacles per round (spikes)
- Win/Lose states, score with obstacle bonus, best score saved locally
- HUD: countdown timer, score, mic volume bar with threshold line

Run locally
1) Use a local web server (required for mic permissions in most browsers):
   - Python 3: `python3 -m http.server 8080`
   - Node (serve): `npx serve --single --listen 8080 --yes`
   - Bun: `bunx serve --port 8080`
2) Open `http://localhost:8080` and click Start, then allow mic.

Gameplay
- 0–44 dB: walk; ≥45 dB: jump. Louder = higher.
- Touching water or spikes = Game Over. Survive 60s = Victory.
- Score = islands crossed (+1 bonus on obstacle islands).

Deploy to GitHub Pages
1) Commit and push the repo to GitHub.
2) In GitHub → Settings → Pages:
   - Source: Deploy from Branch
   - Branch: `main`, Folder: `/ (root)`
3) Save. Your site will publish at `https://<user>.github.io/<repo>/`.

Files
- `index.html`: UI and canvas
- `styles.css`: UI styles
- `main.js`: game loop, mic input, generation, collisions, HUD, storage

Notes
- Mic dB here is an approximate gameplay scale, not calibrated SPL.
