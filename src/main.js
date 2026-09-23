import './ui/styles.css';
import { App } from './App.js';
import { UI } from './ui/UI.js';

function webgl2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

async function boot() {
  const root = document.getElementById('ui');
  if (!webgl2()) {
    root.innerHTML = '<div class="loader"><div class="loader-inner"><div class="brand">GROUND<br>ZERO</div><p style="font-family:var(--mono)">This simulation needs a browser with WebGL 2 enabled.</p></div></div>';
    return;
  }
  const qs = new URLSearchParams(location.search);
  const mobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
  const quality = qs.get('q') || (mobile ? 'low' : 'high');
  const app = new App(document.getElementById('gl'), { quality });
  const ui = new UI(root, app);
  if (qs.get('vs')) { app.volume.scale = +qs.get('vs'); app._resize(); }
  window.__app = app; // handy for debugging from the console
  const canvas = document.getElementById('gl');
  app.on('firstframe', () => canvas.classList.add('ready'));
  app.start();
  app.on('frame', () => ui.update());

  const start = qs.get('scenario');
  if (start) {
    // deep link straight into a sandbox
    ui.showLoader();
    await app.loadScenario(start);
    ui.hideLoader();
    ui.buildHUD();
    const t = parseFloat(qs.get('t'));
    if (!Number.isNaN(t)) app.seek(t);
    if (qs.get('cam')) app.rig.setMode(qs.get('cam'));
    if (qs.get('obs')) { const o = app.scenario.observers.find((x) => x.id === qs.get('obs')); if (o) app.rig.setObserver(o); }
    if (qs.get('photo')) app.setPhoto(true);
    if (qs.get('play')) app.play();
    if (qs.get('hud') === '0') ui.toggleHud();
    return;
  }

  // The intro is on screen immediately; the attract scene (Trinity's cloud a minute after the shot,
  // seen from above Base Camp) loads underneath it and fades in when its first frame is ready.
  ui.showIntro(() => {
    app.rig.orbit.autoRotate = false;
    ui.showArchive();
  });
  await app.loadScenario('trinity');
  if (app.scenario?.id === 'trinity' && !ui.hud) {
    app.seek(55);
    app.rig.setMode('orbit');
    app.camera.position.set(-5200, 2400, 7800);
    app.rig.orbit.target.set(0, 4500, 0);
    app.rig.orbit.autoRotate = !ui.archive;
    app.rig.orbit.autoRotateSpeed = 0.25;
    app.rig.orbit.update();
  }
}

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('ui');
  root.insertAdjacentHTML('beforeend', `<div class="toast panel" style="pointer-events:auto">Something went wrong: ${String(e.message || e).replace(/</g, '&lt;')}</div>`);
});
