# Captain's Gambit: review and publish

`captains-gambit/` is the complete Git repository (19 commits, branch `main`, latest commit `83112c9`).
A pirate Battleship game for the browser: three.js 3D ocean and ships, Higgsfield-generated crew and art,
background music, and an audio settings panel. No server code; it builds to static files.

## 1. Verify
```
cd captains-gambit
git log --oneline | head -1        # expect: 83112c9 Music plays when the game is opened straight from disk (file://)
npm ci
npm test                           # expect: 356 passed, 0 failed
npm run build:site                 # expect: site/index.html (~15.5 MB) + site/music/pirate-music.mp4 (~7.4 MB)
npm run dev                        # play it locally
```

## 2. Review checklist (in the running game)
- Title: four captain cards, Set sail button, key art. Selecting a captain responds instantly.
- Music starts on the first click, loops, fades from 55% to 35% after the versus intro.
- Speaker button (bottom-left) opens the Audio panel: sliders, duck and mute switches, Reset. M key mutes.
- Placement and battle: the chart view, cannon fire, ship fires, sinking.
- Tab boards your ship (first person): helm, stairs to the main deck, crew on the planks.

## 3. Push and publish
1. Push to `https://github.com/vincedelatorre/REPO-NAME` on `main`, keeping all commits (no squash, no force-push over existing commits; rebase onto any README/licence the repo was created with).
2. Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**.
3. The "Publish game to GitHub Pages" workflow (`.github/workflows/pages.yml`) tests, builds and deploys `site/`.
4. When it goes green, confirm `https://vincedelatorre.github.io/REPO-NAME/` loads and the music plays after the first click.

## Notes
- The music (`public/assets/music/pirate-music.mp4`, 7.4 MB) must be pushed; no Git LFS needed. The owner should confirm the rights to this track before the repo or Pages site is public.
- Do not commit `node_modules/`, `dist/`, `dist-single/`, `site/` (already in .gitignore).
- README.md documents controls, architecture, performance notes, audio settings and sharing.
