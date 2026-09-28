# Captain's Gambit (web edition)

Pirate Battleship with a twist: four captains, each with one Gambit per battle, fought in a
storm at sea. Rewritten from the C++/DirectX version as a three.js web game, so it runs in any
current browser, including Safari and Chrome on a Mac.

## Play

```
npm install
npm run dev        # opens the game in your browser
```

Or build one self-contained file you can double-click or host anywhere:

```
npm run build:single   # -> dist-single/captains-gambit.html
```

## Share it: play online with GitHub Pages

Anyone can play in their browser, nothing to install, music included:

1. Push this repo to GitHub.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions** (one time).
3. The workflow in `.github/workflows/pages.yml` tests the game, builds `site/` and publishes it.
   Every later push to `main` republishes automatically (watch progress in the **Actions** tab).
4. Share the link: `https://<your-username>.github.io/<repo-name>/`

`npm run build:site` builds the same site locally: `site/index.html` (the whole game in one file) and
`site/music/pirate-music.mp4` (streamed beside it). Upload that folder to any static host to share it
elsewhere. Open it from a web address, not by double-clicking the file: browsers mute page-processed
audio on `file://` pages.

## Audio settings

The speaker button (bottom-left, every screen) opens the Audio panel: volume sliders for Master, Music (menus),
Music in battle (the music fades to it after the versus intro), Sound effects, Sea, Rain and Wind, a switch to lower the music under cannon fire, and Mute all (also the
**M** key). Settings are saved in the browser. Defaults keep the music forward and the ambience low
(master 80%, music 55%, music in battle 35%, effects 80%, sea 3%, rain 4%, wind 23%); tune the defaults in `AUDIO_DEFAULTS` in `src/audio.js`.

## Performance notes

- Crew: nothing runs while they're hidden (map views); feet are planted on a small set of contact
  vertices found once per character by posing it through every animation.
- Ocean: GPU FFT every frame; the CPU copy (ship motion only) every third frame.
- Map view: no sky or shadow rendering; distant galleons don't cast shadows; shadows switch by
  intensity, never by light setup, so no shader recompiles.
- Menu: no backdrop blur or animated key art; only the selected captain's clip plays; the covered
  3D world isn't drawn.
- Music streams through an `<audio>` element (never decoded whole into memory).

## Art

All art was generated with Higgsfield and ships with the project in `public/assets/`:
captain portraits (`portraits/`), each captain's 8-second performance clip (`video/`, looping,
first and last frame match the portrait), the title key art (`ui/title.jpg`) and the four painted
Gambit emblems cropped from the captain-select concept art (`gambits/`). To swap a piece, drop
a new `.jpg` with the same name in place; `npm run build:single` embeds everything.

## Controls

- Chart: click to fire. `G` uses your Gambit. Right-click or `Esc` cancels aiming.
- `Tab` boards your ship: you start at the helm on the quarterdeck; take the stairs down to the main deck. `W A S D` walk, mouse to look (click, or drag), `1`–`5` change ship,
  `Q` opens the sea chart to fire from the deck.
- `K` comfort mode (less shake, steady horizon), `M` mute, `F` full screen, `Esc` menu, `F1` help.

## How it's built

| File | What it does |
| --- | --- |
| `src/rules.js` | Rules engine: Hasbro Battleship plus all four Gambits. No browser code. |
| `src/ai.js` | Computer captain (probability-density hunting; plays Gambits at sensible moments). |
| `src/ocean.js` | 3-cascade FFT ocean on the GPU: 617 m, 97.3 m and 16.1 m patches (non-harmonic, so no visible tiling), JONSWAP storm spectrum plus a crossing swell, choppy displacement, Jacobian foam that persists and decays. A CPU copy of the big swells drives ship motion. |
| `src/sky.js` | Storm sky (wind-driven cloud decks lit by lightning) and branching lightning bolts. |
| `src/world.js` | The 3D battle: procedural ships and crew, fires, spray, rain, cannonballs, lights, post-processing (bloom, grade, grain), and the camera: chart view, deck view and the swoop between them. |
| `src/overlay.js` | The chart layer: grid, marks and aiming aids projected over the live 3D sea, plus flat charts. |
| `src/game.js` | Game controller: screens, placement, turns, Gambits, and the beat timeline that reveals each shot only when the ball lands. |
| `src/crew.js` | The crew: eight rigged pirates generated with Higgsfield (image to 3D, auto-rigged), sharing walk, talk and hit-reaction clips by bone name; wandering, gathering in small groups that talk with gestures (no dialogue text or audio), fire-fighting when hit. A random five crew each ship every battle. Other ships use the generated galleon model; the ship you're aboard keeps its walkable built deck. |
| `scripts/import-crew.mjs` | Imports downloaded Higgsfield models: recognises each by job id, simplifies meshes, compresses textures (meshopt + JPEG) so the crew fits in the single-file game. |
| `src/audio.js` | Every sound synthesized with WebAudio at startup (no audio files). |
| `index.html` | Page structure and all UI styling. |

Sky and light: a split sky, sunset breaking through on one side and a raining, lightning-lit storm
on the other, blended through torn cloud. The low sun is the key light and casts long shadows; lanterns and fires are warm
point lights; a filmic grade after tone mapping adds contrast (S-curve) and splits teal
shadows from warm highlights.

The chart is the same 3D world seen from straight above, so your ships in the chart are the
real ships riding the swell, and `Tab` flies the camera down onto the deck.

## Tests

```
npm test           # 356 rules and AI checks
npm run balance    # AI-vs-AI win rates per captain
```

Gambits are ready from turn one. To bring back the old "unlock on first hit" rule, set
`unlockOnFirstHit = true` in `src/rules.js` (the balance report shows both settings).

## Requirements

WebGL 2 with float render targets (every current desktop browser; turn on hardware
acceleration if it's off). The ocean runs 3 x 256x256 FFTs per frame, so a laptop GPU is
plenty; integrated graphics on older machines may prefer a smaller window.
