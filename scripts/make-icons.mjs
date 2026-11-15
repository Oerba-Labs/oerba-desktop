// Renders Oerba's mark to the app icon and the menu bar's template images.
//
// Why: the mark is one set of shapes (the wallaby's head and scarf, in silhouette); the PNGs are made from it
// so they never drift apart. Electron draws the SVG offscreen and capturePage reads the pixels back, on a
// transparent ground, so no other tool is needed.
//
// Run (from the repository root, after `npm ci --ignore-scripts` and electron's install.js):
//   node_modules/.bin/electron scripts/make-icons.mjs
// Writes build-resources/icon.svg and icon.png (1024x1024), static/trayTemplate.png (18x18) and
// static/trayTemplate@2x.png (36x36). electron-builder makes the .icns from icon.png.
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The silhouette, in the coordinates of the viewBox "60 -4 84 84". It spans x 70..134.6, y -1..77, centre (102.3, 38).
const SHAPES = `<path d="M84,38 C77,24 76,10 80,2 C87,6 93,20 93,34 Z"/>
<path d="M80,50 C78,36 88,26 100,26 C110,26 117,32 121,38 C127,42 133,46 132,53 C131,59 123,61 113,61 C99,62 84,62 80,50 Z"/>
<path d="M104,59 C112,60 122,59 130,55.5 C129,59.5 122,61.6 113,61.6 C108,61.6 105,60.6 104,59 Z"/>
<ellipse cx="131" cy="49.5" rx="3.6" ry="3"/>
<path d="M92,34 C89,19 91,6 98,-1 C105,6 106,21 101,35 Z"/>
<path d="M80,64 L70,74 L76,77 L86,68 Z"/>
<path d="M80,60 C88,67 99,68 106,63 L107,69 C99,74 87,73 79,66 Z"/>`;
const CX = 102.3, CY = 38, H = 78;   // the silhouette's centre and height

// App icon: Apple's grid, a 824 square centred in 1024, radius 185; the mark about 60% of the body wide (the taller side).
const scale = (824 * 0.6) / H;
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#E0672A"/>
<g fill="#FFFFFF" transform="translate(512 512) scale(${scale.toFixed(4)}) translate(${-CX} ${-CY})">
${SHAPES}
</g>
</svg>
`;

// Menu bar: black on transparent (macOS tints a Template image), one point of padding on an 18-point square.
const side = H * 18 / 16;
const traySvg = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${CX - side / 2} ${CY - side / 2} ${side} ${side}">
<g fill="#000000">${SHAPES}</g></svg>`;

// One window for every image (a second window would not load under offscreen rendering); each image replaces the page's
// contents and is read from the top-left of the window. Chromium will not make a tiny one, so it is always 1024 square.
let win;
async function render(svg, px, out) {
  if (!win) {
    win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false,
      backgroundColor: "#00000000", webPreferences: { offscreen: true, sandbox: true } });
    await win.loadURL("data:text/html;base64," + Buffer.from(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style><body>`).toString("base64"));
  }
  await win.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(svg)}`);
  await new Promise((r) => setTimeout(r, 300));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
  const s = img.getSize();
  if (s.width !== px || s.height !== px) img = img.resize({ width: px, height: px, quality: "best" });
  writeFileSync(out, img.toPNG());
  console.log("wrote", path.relative(root, out), `${px}x${px}`);
}

app.whenReady().then(async () => {
  writeFileSync(path.join(root, "build-resources/icon.svg"), iconSvg);
  await render(iconSvg, 1024, path.join(root, "build-resources/icon.png"));
  await render(traySvg(18), 18, path.join(root, "static/trayTemplate.png"));
  await render(traySvg(36), 36, path.join(root, "static/trayTemplate@2x.png"));
  win.destroy();
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
