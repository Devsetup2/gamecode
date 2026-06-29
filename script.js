// =========================================================
// Aa+  —  AA-style gameplay (rotating hub + launch & stick)
// =========================================================

const STORAGE_KEY = "aaplus_save_v1";

const defaultState = {
  level: 1,
  bestScore: 0,
  score: 0,
  settings: {
    dark: true,
    anim: true,
    sfx: true,
    haptics: true,
    difficulty: "normal"
  }
};

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return structuredClone(defaultState);
    const saved = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...saved,
      settings: { ...defaultState.settings, ...(saved.settings || {}) }
    };
  }catch(e){
    return structuredClone(defaultState);
  }
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){ /* storage unavailable */ }
}

let state = loadState();

// ---------------------------------------------------------
// AUDIO
// ---------------------------------------------------------
const bgMusic = new Audio("bg-music.mp3");
bgMusic.loop = true;
bgMusic.volume = 0.35;
bgMusic.preload = "auto";

let musicStarted = false;

function tryStartMusic(){
  if(musicStarted || !state.settings.sfx) return;
  bgMusic.play().then(() => { musicStarted = true; }).catch(() => {});
}

function syncMusic(){
  if(!state.settings.sfx){
    bgMusic.pause();
    return;
  }
  if(musicStarted) bgMusic.play().catch(() => {});
}

let audioCtx = null;

function getAudioCtx(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playTone(freq, duration, type = "sine", volume = 0.12){
  if(!state.settings.sfx) return;
  try{
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }catch(e){ /* audio unavailable */ }
}

function playHitSfx(){
  playTone(660, 0.08, "sine", 0.1);
  setTimeout(() => playTone(880, 0.1, "sine", 0.08), 60);
}

function playMissSfx(){
  playTone(180, 0.25, "square", 0.07);
}

function playLevelSfx(){
  playTone(520, 0.1, "sine", 0.1);
  setTimeout(() => playTone(780, 0.12, "sine", 0.1), 90);
  setTimeout(() => playTone(1040, 0.15, "sine", 0.08), 180);
}

function vibrate(pattern){
  if(state.settings.haptics && navigator.vibrate){
    navigator.vibrate(pattern);
  }
}

// ---------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------
function goTo(pageId){
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById(pageId);
  if(target) target.classList.add("active");
  if(pageId === "page-map") renderMap();
  if(pageId === "page-game"){
    startGameSession();
  } else {
    stopGameSession();
  }
  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-nav]").forEach(btn => {
  btn.addEventListener("click", () => {
    tryStartMusic();
    goTo(btn.dataset.nav);
  });
});

// ---------------------------------------------------------
// START PAGE
// ---------------------------------------------------------
function renderStart(){
  document.getElementById("start-best").textContent = state.bestScore.toLocaleString("tr-TR");
  document.getElementById("start-level").textContent = state.level;
}

// ---------------------------------------------------------
// GAME — rotating hub, launch queue, collision
// ---------------------------------------------------------
const WHEEL_CENTER = 180;
const ATTACH_RADIUS = 118;
const BALL_ARC = 0.30;
const FLY_DURATION = 240;
const NODE_R = 13;

const DIFFICULTY_MULT = { easy: 0.72, normal: 1, hard: 1.38 };

let wheelAngle = 0;
let paused = false;
let gameActive = false;
let animFrameId = null;
let lastTimestamp = 0;
let flyEl = null;

let levelSession = {
  params: null,
  attached: [],
  queue: [],
  flying: null,
  gameOver: false,
  completing: false
};

function getLevelParams(level){
  const diff = DIFFICULTY_MULT[state.settings.difficulty] || 1;
  const totalBalls = Math.min(3 + Math.floor((level - 1) / 2), 12);
  const prePlaced = Math.min(Math.floor((level - 1) / 4), 4);
  const baseSpeed = (0.022 + (level - 1) * 0.0014) * diff;
  const direction = level % 2 === 0 ? -1 : 1;
  const rhythmAmp = Math.min(0.55, 0.22 + (level % 6) * 0.06);
  const rhythmFreq = 0.0018 + level * 0.00025;
  return { totalBalls, prePlaced, baseSpeed, direction, rhythmAmp, rhythmFreq };
}

function angularDist(a, b){
  let d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function generatePrePlaced(count){
  const angles = [];
  const minDist = BALL_ARC * 1.15;
  let attempts = 0;
  while(angles.length < count && attempts < 300){
    attempts++;
    const a = Math.random() * 2 * Math.PI;
    if(angles.every(ex => angularDist(ex, a) >= minDist)){
      angles.push(a);
    }
  }
  return angles.map((angle, i) => ({
    angle,
    number: -(i + 1),
    prePlaced: true
  }));
}

function initLevel(){
  const params = getLevelParams(state.level);
  levelSession.params = params;
  levelSession.attached = generatePrePlaced(params.prePlaced);
  levelSession.queue = Array.from({ length: params.totalBalls }, (_, i) => i + 1);
  levelSession.flying = null;
  levelSession.gameOver = false;
  levelSession.completing = false;
  wheelAngle = 0;
  removeFlyEl();
  renderGame();
}

function getAttachAngle(){
  let local = -Math.PI / 2 - wheelAngle;
  local = ((local % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return local;
}

function checkCollision(angle){
  return levelSession.attached.some(b => angularDist(b.angle, angle) < BALL_ARC);
}

function renderWheel(){
  const svg = document.getElementById("wheel-svg");
  if(!svg) return;
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  const total = levelSession.params
    ? levelSession.params.totalBalls + levelSession.params.prePlaced
    : 1;
  const done = levelSession.attached.length;

  const trackCircle = document.createElementNS(ns, "circle");
  trackCircle.setAttribute("cx", WHEEL_CENTER);
  trackCircle.setAttribute("cy", WHEEL_CENTER);
  trackCircle.setAttribute("r", 100);
  trackCircle.setAttribute("class", "ring-track");
  svg.appendChild(trackCircle);

  const progressArc = document.createElementNS(ns, "circle");
  const circumference = 2 * Math.PI * 100;
  const progressPct = total > 0 ? done / total : 0;
  progressArc.setAttribute("cx", WHEEL_CENTER);
  progressArc.setAttribute("cy", WHEEL_CENTER);
  progressArc.setAttribute("r", 100);
  progressArc.setAttribute("class", "ring-progress");
  progressArc.setAttribute("stroke-dasharray", `${circumference * progressPct} ${circumference}`);
  progressArc.setAttribute("transform", `rotate(-90 ${WHEEL_CENTER} ${WHEEL_CENTER})`);
  svg.appendChild(progressArc);

  levelSession.attached.forEach(ball => {
    const angle = ball.angle;
    const x = WHEEL_CENTER + ATTACH_RADIUS * Math.cos(angle);
    const y = WHEEL_CENTER + ATTACH_RADIUS * Math.sin(angle);

    const innerX = WHEEL_CENTER + 102 * Math.cos(angle);
    const innerY = WHEEL_CENTER + 102 * Math.sin(angle);
    const spoke = document.createElementNS(ns, "line");
    spoke.setAttribute("x1", innerX);
    spoke.setAttribute("y1", innerY);
    spoke.setAttribute("x2", x);
    spoke.setAttribute("y2", y);
    spoke.setAttribute("class", "spoke");
    svg.appendChild(spoke);

    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", NODE_R);
    circle.setAttribute("class", "node");
    svg.appendChild(circle);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", y);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "central");
    label.setAttribute("class", "node-label");
    const rotateDeg = (angle * 180 / Math.PI) + 90;
    label.setAttribute("transform", `rotate(${rotateDeg} ${x} ${y})`);
    label.textContent = ball.number > 0 ? ball.number : "·";
    svg.appendChild(label);
  });

  const wheelNumEl = document.getElementById("wheel-number");
  if(wheelNumEl) wheelNumEl.textContent = state.level;
}

function renderTrack(){
  const zone = document.getElementById("track-zone");
  if(!zone) return;
  zone.innerHTML = "";

  const stuck = levelSession.attached.filter(b => !b.prePlaced).length;
  const next = levelSession.queue[0];
  const rest = levelSession.queue.slice(1);

  if(stuck > 0){
    const activeEl = document.createElement("div");
    activeEl.className = "track-node-active";
    activeEl.textContent = stuck;
    zone.appendChild(activeEl);

    const connector = document.createElement("div");
    connector.className = "track-connector";
    zone.appendChild(connector);
  }

  if(next !== undefined){
    const currentEl = document.createElement("div");
    currentEl.className = "track-node-current";
    currentEl.textContent = next;
    zone.appendChild(currentEl);
  } else if(!levelSession.completing){
    const emptyEl = document.createElement("div");
    emptyEl.className = "track-future";
    emptyEl.textContent = "—";
    zone.appendChild(emptyEl);
  }

  rest.forEach(num => {
    const dot = document.createElement("div");
    dot.className = "track-dot";
    zone.appendChild(dot);
    const future = document.createElement("div");
    future.className = "track-future";
    future.textContent = num;
    zone.appendChild(future);
  });
}

function renderGame(){
  document.getElementById("game-level").textContent = `SEVİYE: ${state.level}`;
  document.getElementById("game-best").textContent = state.bestScore.toLocaleString("tr-TR");
  document.getElementById("game-score").textContent = state.score.toLocaleString("tr-TR");
  document.getElementById("pass-level").textContent = state.level + 1;
  renderWheel();
  renderTrack();
  applyWheelTransform();
}

function applyWheelTransform(){
  const svg = document.getElementById("wheel-svg");
  if(svg){
    svg.style.transform = `rotate(${wheelAngle}rad)`;
    svg.style.transformOrigin = "center center";
  }
}

function ensureFlyEl(){
  if(flyEl) return flyEl;
  const zone = document.getElementById("wheel-zone");
  flyEl = document.createElement("div");
  flyEl.style.cssText = [
    "position:absolute",
    "width:46px",
    "height:46px",
    "border-radius:50%",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-weight:700",
    "font-size:15px",
    "pointer-events:none",
    "z-index:5",
    "border:2px solid #ff3b4e",
    "color:#ff3b4e",
    "background:#0e1116",
    "box-shadow:0 0 14px rgba(255,59,78,0.6)",
    "left:50%",
    "transform:translate(-50%,-50%)",
    "display:none"
  ].join(";");
  zone.appendChild(flyEl);
  return flyEl;
}

function removeFlyEl(){
  if(flyEl){
    flyEl.style.display = "none";
    levelSession.flying = null;
  }
}

function updateFlyingBall(){
  const fly = levelSession.flying;
  if(!fly) return;

  const elapsed = performance.now() - fly.startTime;
  const t = Math.min(1, elapsed / FLY_DURATION);
  const ease = 1 - Math.pow(1 - t, 3);

  const zone = document.getElementById("wheel-zone");
  const el = ensureFlyEl();
  const h = zone.clientHeight;
  const startY = h * 0.92;
  const endY = h * 0.14;
  const y = startY + (endY - startY) * ease;

  el.textContent = fly.number;
  el.style.display = "flex";
  el.style.top = `${y}px`;

  if(t >= 1){
    levelSession.flying = null;
    el.style.display = "none";
    resolveLaunch(fly.number);
  }
}

function resolveLaunch(number){
  const attachAngle = getAttachAngle();

  if(checkCollision(attachAngle)){
    onCollision();
    return;
  }

  levelSession.attached.push({ angle: attachAngle, number, prePlaced: false });
  levelSession.queue.shift();
  state.score += 50 + state.level * 5;
  if(state.score > state.bestScore) state.bestScore = state.score;
  saveState();
  playHitSfx();
  vibrate(20);
  pulse(document.getElementById("wheel-number"));
  renderGame();

  if(levelSession.queue.length === 0){
    onLevelComplete();
  }
}

function handleLaunch(){
  if(!gameActive || paused || levelSession.gameOver || levelSession.completing) return;
  if(levelSession.flying || levelSession.queue.length === 0) return;

  tryStartMusic();
  if(audioCtx && audioCtx.state === "suspended") audioCtx.resume();

  const number = levelSession.queue[0];
  levelSession.flying = { number, startTime: performance.now() };
  ensureFlyEl();
}

function onCollision(){
  levelSession.gameOver = true;
  playMissSfx();
  vibrate([50, 40, 50]);
  flashError();

  setTimeout(() => {
    if(gameActive) initLevel();
  }, 900);
}

function onLevelComplete(){
  levelSession.completing = true;
  playLevelSfx();
  pulse(document.getElementById("wheel-number"));

  const bonus = state.level * 100;
  state.score += bonus;
  if(state.score > state.bestScore) state.bestScore = state.score;
  state.level += 1;
  saveState();
  renderStart();

  setTimeout(() => {
    if(gameActive){
      initLevel();
      renderStart();
    }
  }, 1100);
}

function gameLoop(timestamp){
  if(!gameActive){
    animFrameId = null;
    return;
  }

  if(!lastTimestamp) lastTimestamp = timestamp;
  const delta = Math.min((timestamp - lastTimestamp) / 16.67, 3);
  lastTimestamp = timestamp;

  if(!paused && !levelSession.gameOver && !levelSession.completing){
    const p = levelSession.params;
    if(p){
      const rhythm = 1 + p.rhythmAmp * Math.sin(timestamp * p.rhythmFreq);
      wheelAngle += p.baseSpeed * p.direction * delta * rhythm;
      applyWheelTransform();
    }
    updateFlyingBall();
  }

  animFrameId = requestAnimationFrame(gameLoop);
}

function startGameSession(){
  gameActive = true;
  paused = false;
  lastTimestamp = 0;
  const pauseBtn = document.getElementById("btn-pause");
  if(pauseBtn){
    pauseBtn.querySelector(".footer-btn-title").textContent = "PAUSE";
  }
  document.getElementById("wheel-zone")?.classList.remove("paused");
  initLevel();
  if(!animFrameId) animFrameId = requestAnimationFrame(gameLoop);
  syncMusic();
}

function stopGameSession(){
  gameActive = false;
  removeFlyEl();
  if(animFrameId){
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

const gamePage = document.getElementById("page-game");
if(gamePage){
  gamePage.addEventListener("click", (e) => {
    if(e.target.closest(".game-footer, .game-header, .icon-btn")) return;
    handleLaunch();
  });
  gamePage.addEventListener("touchstart", (e) => {
    if(e.target.closest(".game-footer, .game-header, .icon-btn")) return;
    e.preventDefault();
    handleLaunch();
  }, { passive: false });
}

document.getElementById("btn-pass").addEventListener("click", () => {
  if(!gameActive || levelSession.completing) return;
  levelSession.queue = [];
  onLevelComplete();
});

document.getElementById("btn-error").addEventListener("click", () => {
  if(!gameActive) return;
  initLevel();
  flashError();
});

document.getElementById("btn-pause").addEventListener("click", (e) => {
  paused = !paused;
  e.currentTarget.querySelector(".footer-btn-title").textContent = paused ? "DEVAM" : "PAUSE";
  document.getElementById("wheel-zone")?.classList.toggle("paused", paused);
  if(!paused && gameActive && !animFrameId){
    lastTimestamp = 0;
    animFrameId = requestAnimationFrame(gameLoop);
  }
});

function pulse(el){
  if(!el || !state.settings.anim) return;
  el.style.transition = "transform .15s ease";
  el.style.transform = "scale(1.12)";
  setTimeout(() => { el.style.transform = "scale(1)"; }, 150);
}

function flashError(){
  const core = document.querySelector(".wheel-core");
  if(!core) return;
  core.style.boxShadow = "0 0 0 2px rgba(255,59,78,0.8), 0 0 40px rgba(255,59,78,0.55), inset 0 0 30px rgba(0,0,0,0.6)";
  setTimeout(() => {
    core.style.boxShadow = "0 0 0 2px rgba(52,224,224,0.55), 0 0 40px rgba(52,224,224,0.35), inset 0 0 30px rgba(0,0,0,0.6)";
  }, 280);
}

// ---------------------------------------------------------
// MAP PAGE
// ---------------------------------------------------------
const MAP_LEVEL_COUNT = 30;

function renderMap(){
  const track = document.getElementById("map-track");
  if(!track) return;
  track.innerHTML = "";

  for(let lvl = 1; lvl <= MAP_LEVEL_COUNT; lvl++){
    const row = document.createElement("div");
    const side = lvl % 3 === 0 ? "center" : (lvl % 2 === 0 ? "right" : "left");
    row.className = `map-row ${side === "center" ? "" : side}`;

    const node = document.createElement("div");
    let cls = "map-node";
    if(lvl < state.level) cls += " done";
    else if(lvl === state.level) cls += " current";
    else cls += " locked";
    node.className = cls;
    node.textContent = lvl;

    node.addEventListener("click", () => {
      if(lvl <= state.level){
        state.level = lvl;
        saveState();
        goTo("page-game");
      }
    });

    row.appendChild(node);
    track.appendChild(row);

    if(lvl < MAP_LEVEL_COUNT){
      const connectorWrap = document.createElement("div");
      connectorWrap.style.display = "flex";
      connectorWrap.style.justifyContent = side === "center" ? "center" : side === "right" ? "flex-end" : "flex-start";
      connectorWrap.style.width = "100%";

      const connector = document.createElement("div");
      connector.className = "map-connector-v" + (lvl < state.level ? " done" : "");
      connectorWrap.appendChild(connector);
      track.appendChild(connectorWrap);
    }
  }
}

// ---------------------------------------------------------
// SETTINGS PAGE
// ---------------------------------------------------------
function renderSettings(){
  document.getElementById("toggle-dark").checked = state.settings.dark;
  document.getElementById("toggle-anim").checked = state.settings.anim;
  document.getElementById("toggle-sfx").checked = state.settings.sfx;
  document.getElementById("toggle-haptics").checked = state.settings.haptics;
  document.getElementById("select-difficulty").value = state.settings.difficulty;
  document.body.style.filter = state.settings.dark ? "none" : "invert(1) hue-rotate(180deg)";
}

document.getElementById("toggle-dark").addEventListener("change", e => {
  state.settings.dark = e.target.checked;
  document.body.style.filter = state.settings.dark ? "none" : "invert(1) hue-rotate(180deg)";
  saveState();
});

document.getElementById("toggle-anim").addEventListener("change", e => {
  state.settings.anim = e.target.checked;
  saveState();
});

document.getElementById("toggle-sfx").addEventListener("change", e => {
  state.settings.sfx = e.target.checked;
  syncMusic();
  saveState();
});

document.getElementById("toggle-haptics").addEventListener("change", e => {
  state.settings.haptics = e.target.checked;
  saveState();
});

document.getElementById("select-difficulty").addEventListener("change", e => {
  state.settings.difficulty = e.target.value;
  if(gameActive) initLevel();
  saveState();
});

document.getElementById("btn-reset-progress").addEventListener("click", () => {
  if(confirm("Tüm ilerleme silinsin mi? Bu işlem geri alınamaz.")){
    const keptSettings = state.settings;
    state = structuredClone(defaultState);
    state.settings = keptSettings;
    wheelAngle = 0;
    saveState();
    renderStart();
    renderSettings();
    if(gameActive) initLevel();
  }
});

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------
document.addEventListener("click", tryStartMusic, { once: true });
document.addEventListener("touchstart", tryStartMusic, { once: true });

renderStart();
renderSettings();
goTo("page-start");
