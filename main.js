"use strict";

// Constants
const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const FLOOR_Y = GAME_HEIGHT * 0.75; // Ocean baseline
const ROUND_SECONDS = 60;
const MIC_THRESHOLD_DB = 42; // >=42 dB enables movement and flight
const MIN_OBSTACLES_PER_ROUND = 15;
const TARGET_PLATFORMS_PER_ROUND = 50; // ensure at least 50 islands spawn
const PRESPAWN_RANGE = GAME_WIDTH * 6; // pre-generate far ahead so many are visible in sequence

const PLATFORM_VARIANTS = [
  { name: "very_thin", minWidth: 80,  maxWidth: 120, gapMin: 120, gapMax: 220, weight: 0.20 },
  { name: "thin",       minWidth: 130, maxWidth: 180, gapMin: 150, gapMax: 260, weight: 0.35 },
  { name: "medium",     minWidth: 190, maxWidth: 260, gapMin: 170, gapMax: 300, weight: 0.30 },
  { name: "big",        minWidth: 280, maxWidth: 380, gapMin: 200, gapMax: 360, weight: 0.15 }
];

// Canvas
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// UI Elements
const timerEl = document.getElementById("timer");
const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");
const micFillEl = document.getElementById("mic-fill");
const startBtn = document.getElementById("start-btn");
const centerOverlay = document.getElementById("center-overlay");
const resultOverlay = document.getElementById("result-overlay");
const resultTitle = document.getElementById("result-title");
const resultSub = document.getElementById("result-sub");
const retryBtn = document.getElementById("retry-btn");
const muteBtn = document.getElementById("mute-btn");

// Audio state
let audioContext = null;
let mediaStream = null;
let analyser = null;
let isMuted = false;
let lastDb = 0;

// Game state
let rng = Math.random;
let gameStarted = false;
let gameOver = false;
let win = false;
let elapsed = 0; // seconds
let lastTimestamp = 0;
let score = 0;
let best = Number(localStorage.getItem("moo_best") || 0);
bestEl.textContent = `Best: ${best}`;

// Entities
class Cow {
  constructor() {
    this.x = GAME_WIDTH * 0.2;
    this.y = FLOOR_Y - 40; // Default standing
    this.width = 60;
    this.height = 40;
    this.velY = 0;
    this.gravity = 1600; // px/s^2
    this.liftScale = 60; // px/s^2 per dB over threshold (more responsive)
    this.walkSpeed = 240; // px/s world scroll speed (faster)
    this.onGround = false;
    this.inWater = false;
  }

  update(dt, platforms, db) {
    // Apply gravity minus any upward thrust from voice
    const over = Math.max(0, (db || 0) - MIC_THRESHOLD_DB);
    const liftAccel = over > 0 ? over * this.liftScale : 0;
    const netAccel = this.gravity - liftAccel;
    this.velY += netAccel * dt;
    this.y += this.velY * dt;

    // Check collision with platforms from top
    let grounded = false;
    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      if (!p.visible) continue;
      const cowBottom = this.y + this.height;
      const prevBottom = this.y + this.height - this.velY * dt; // previous position
      if (
        this.x + this.width > p.x &&
        this.x < p.x + p.width &&
        prevBottom <= p.y &&
        cowBottom >= p.y
      ) {
        // Landed on platform
        this.y = p.y - this.height;
        this.velY = 0;
        grounded = true;
      }
    }
    this.onGround = grounded;

    // Water fail (fell below floor)
    if (this.y + this.height > FLOOR_Y + 4) {
      this.inWater = true;
      endGame(false, `You splashed after ${score} islands`);
    }

    // Clamp to not fly off the top of the screen
    if (this.y < 10) {
      this.y = 10;
      if (this.velY < 0) this.velY = 0;
    }
  }

  render(ctx) {
    // Placeholder cow: rounded rect with spots
    ctx.save();
    ctx.fillStyle = "#fff";
    const r = 10;
    roundedRect(ctx, this.x, this.y, this.width, this.height, r);
    ctx.fill();

    // Spots
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.ellipse(this.x + 18, this.y + 20, 10, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(this.x + 40, this.y + 12, 8, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.fillStyle = "#fff";
    ctx.fillRect(this.x + this.width - 12, this.y + 8, 18, 14);
    ctx.fillStyle = "#fca5a5";
    ctx.fillRect(this.x + this.width - 10, this.y + 16, 16, 10);
    ctx.restore();
  }
}

class Platform {
  constructor(x, width) {
    this.x = x;
    this.width = width;
    this.height = 120 + Math.floor(rng() * 80);
    this.y = FLOOR_Y - this.height;
    this.visible = true;
    this.hasObstacle = false;
    this.obstacles = [];
    this.scored = false;
    this.aerialObstacles = [];
  }

  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) this.visible = false;
    for (let i = 0; i < this.obstacles.length; i++) {
      this.obstacles[i].update(dt, speed);
    }
    for (let i = 0; i < this.aerialObstacles.length; i++) {
      this.aerialObstacles[i].update(dt, speed);
    }
  }

  render(ctx) {
    // Tower island: brown base + green top
    ctx.save();
    ctx.fillStyle = "#854d0e";
    ctx.fillRect(this.x, this.y, this.width, this.height);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(this.x - 4, this.y - 10, this.width + 8, 14);
    ctx.restore();

    for (let i = 0; i < this.obstacles.length; i++) this.obstacles[i].render(ctx);
    for (let i = 0; i < this.aerialObstacles.length; i++) this.aerialObstacles[i].render(ctx);
  }
}

class Obstacle {
  constructor(platform) {
    this.platform = platform;
    this.width = 28 + Math.floor(rng() * 30);
    this.height = 28 + Math.floor(rng() * 28);
    const margin = 12;
    this.x = platform.x + margin + rng() * Math.max(1, platform.width - margin * 2 - this.width);
    this.y = platform.y - this.height;
    this.visible = true;
  }

  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) this.visible = false;
  }

  render(ctx) {
    // Spiky triangle
    ctx.save();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(this.x, this.y + this.height);
    ctx.lineTo(this.x + this.width / 2, this.y);
    ctx.lineTo(this.x + this.width, this.y + this.height);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

class AerialObstacle {
  constructor(platform) {
    this.platform = platform;
    this.width = 18 + Math.floor(rng() * 12);
    this.height = 14 + Math.floor(rng() * 12);
    const margin = 24;
    this.x = platform.x + margin + rng() * Math.max(1, platform.width - margin * 2 - this.width);
    // Place above platform; clamp fully within screen (with padding)
    const desiredY = platform.y - (100 + Math.floor(rng() * 140)) - this.height;
    const minY = 10;
    const maxY = GAME_HEIGHT - this.height - 10;
    this.y = Math.max(minY, Math.min(maxY, desiredY));
    this.visible = true;
  }

  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) this.visible = false;
  }

  render(ctx) {
    ctx.save();
    ctx.fillStyle = "#f87171";
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.x + this.width / 2, this.y);
    ctx.lineTo(this.x + this.width, this.y + this.height / 2);
    ctx.lineTo(this.x + this.width / 2, this.y + this.height);
    ctx.lineTo(this.x, this.y + this.height / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

class AirObstacle {
  constructor(x) {
    this.width = 20 + Math.floor(rng() * 18);
    this.height = 16 + Math.floor(rng() * 14);
    this.x = x;
    // Random vertical band in the air, not too close to floor or ceiling
    const minY = 40;
    const maxY = FLOOR_Y - 120;
    this.y = minY + Math.floor(rng() * Math.max(1, maxY - minY));
    this.visible = true;
  }

  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) this.visible = false;
  }

  render(ctx) {
    ctx.save();
    ctx.fillStyle = "#fb7185";
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.x + this.width / 2, this.y);
    ctx.lineTo(this.x + this.width, this.y + this.height / 2);
    ctx.lineTo(this.x + this.width / 2, this.y + this.height);
    ctx.lineTo(this.x, this.y + this.height / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// World
let cow = new Cow();
let platforms = [];
let nextPlatformX = GAME_WIDTH * 0.6;
let obstacleCountThisRound = 0;
let platformsSpawned = 0; // number of platforms created this round
let airObstacles = []; // free-floating obstacles in gaps

function resetGame() {
  gameStarted = true;
  gameOver = false;
  win = false;
  elapsed = 0;
  lastTimestamp = 0;
  score = 0;
  platforms = [];
  nextPlatformX = GAME_WIDTH * 0.5;
  obstacleCountThisRound = 0;
  platformsSpawned = 0;
  airObstacles = [];
  cow = new Cow();
  centerOverlay.classList.remove("visible");
  centerOverlay.classList.add("hidden");
  resultOverlay.classList.add("hidden");

  // Create a starting island under the cow so the game doesn't begin in water
  const startWidth = 320;
  const startX = Math.max(0, cow.x - startWidth * 0.4);
  const startPlatform = new Platform(startX, startWidth);
  platforms.push(startPlatform);
  // Place cow on top of starting platform
  cow.y = startPlatform.y - cow.height;
  cow.velY = 0;
  cow.onGround = true;
  // Advance the next spawn position after the starting platform and an initial gap
  const initialGap = 180;
  nextPlatformX = startPlatform.x + startPlatform.width + initialGap;

  // Pre-spawn a large set so the run has many islands from the start
  maybeSpawn();
}

// Platform/Obstacle generation
function maybeSpawn() {
  // Pre-generate much further ahead to ensure many islands over time
  const spawnLimit = Math.max(GAME_WIDTH * 1.6, PRESPAWN_RANGE);
  while (nextPlatformX < spawnLimit) {
    // Choose a platform variant by weight
    let r = rng();
    let chosen = PLATFORM_VARIANTS[PLATFORM_VARIANTS.length - 1];
    for (let i = 0, acc = 0; i < PLATFORM_VARIANTS.length; i++) {
      acc += PLATFORM_VARIANTS[i].weight;
      if (r <= acc) { chosen = PLATFORM_VARIANTS[i]; break; }
    }
    const width = chosen.minWidth + Math.floor(rng() * (chosen.maxWidth - chosen.minWidth + 1));
    const gap = chosen.gapMin + Math.floor(rng() * (chosen.gapMax - chosen.gapMin + 1));
    const p = new Platform(nextPlatformX, width);

    // At least N obstacles in 60s: bias obstacle probability to guarantee
    const remainingTime = Math.max(0, ROUND_SECONDS - elapsed);
    const need = Math.max(0, MIN_OBSTACLES_PER_ROUND - obstacleCountThisRound);
    const estPlatformsRemaining = Math.max(need, Math.ceil(remainingTime));
    const baseProbability = 0.65; // higher base chance for more obstacles
    const forceProbability = need > 0 ? Math.min(0.95, Math.max(baseProbability, need / Math.max(1, estPlatformsRemaining))) : baseProbability;
    if (rng() < forceProbability) {
      p.hasObstacle = true;
      // Place 1-3 obstacles depending on width
      const maxObstacles = p.width > 260 ? 3 : p.width > 180 ? 2 : 1;
      const count = 1 + (rng() < 0.6 && maxObstacles >= 2 ? 1 : 0) + (rng() < 0.3 && maxObstacles >= 3 ? 1 : 0);
      for (let k = 0; k < count; k++) {
        p.obstacles.push(new Obstacle(p));
        obstacleCountThisRound += 1;
      }
    }

    // After 7 islands crossed (score), add small aerial obstacles above platforms more often
    if (score >= 7) {
      const aerialChance = p.width >= 180 ? 0.65 : 0.45;
      if (rng() < aerialChance) {
        const aerialCount = rng() < 0.35 && p.width >= 240 ? 2 : 1;
        for (let a = 0; a < aerialCount; a++) {
          p.aerialObstacles.push(new AerialObstacle(p));
        }
      }
    }

    platforms.push(p);
    nextPlatformX += width + gap;
    // Spawn free-floating air obstacles in the center of the gap
    const gapMidX = nextPlatformX - Math.floor(gap / 2);
    if (gap >= 140 && rng() < 0.6) {
      const numAir = rng() < 0.4 ? 2 : 1;
      for (let n = 0; n < numAir; n++) {
        const jitter = (rng() - 0.5) * gap * 0.3;
        airObstacles.push(new AirObstacle(gapMidX + jitter));
      }
    }
    platformsSpawned += 1;
  }
}

// Collision checks
function checkObstacleCollision() {
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    if (!p.visible) continue;
    for (let j = 0; j < p.obstacles.length; j++) {
      const o = p.obstacles[j];
      if (
        cow.x < o.x + o.width &&
        cow.x + cow.width > o.x &&
        cow.y < o.y + o.height &&
        cow.y + cow.height > o.y
      ) {
        endGame(false, `Ouch! Hit spikes after ${score} islands`);
        return;
      }
    }
    for (let j = 0; j < p.aerialObstacles.length; j++) {
      const ao = p.aerialObstacles[j];
      if (
        cow.x < ao.x + ao.width &&
        cow.x + cow.width > ao.x &&
        cow.y < ao.y + ao.height &&
        cow.y + cow.height > ao.y
      ) {
        endGame(false, `Ouch! Hit spikes after ${score} islands`);
        return;
      }
    }
  }
  // Check free-floating air obstacles
  for (let k = 0; k < airObstacles.length; k++) {
    const o = airObstacles[k];
    if (
      cow.x < o.x + o.width &&
      cow.x + cow.width > o.x &&
      cow.y < o.y + o.height &&
      cow.y + cow.height > o.y
    ) {
      endGame(false, `Ouch! Hit spikes after ${score} islands`);
      return;
    }
  }
}

function updateScore() {
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    if (!p.visible || p.scored) continue;
    if (p.x + p.width < cow.x) {
      p.scored = true;
      score += 1;
      // Bonus for obstacle platforms
      if (p.hasObstacle) score += Math.min(2, p.obstacles.length);
    }
  }
  scoreEl.textContent = `Score: ${score}`;
}

// Rendering helpers
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderBackground() {
  // Ocean base
  ctx.fillStyle = "#1d4ed8";
  ctx.fillRect(0, FLOOR_Y, GAME_WIDTH, GAME_HEIGHT - FLOOR_Y);
  // Waves
  ctx.strokeStyle = "#60a5fa";
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 4; i++) {
    const y = FLOOR_Y + 8 + i * 10;
    ctx.beginPath();
    for (let x = 0; x < GAME_WIDTH; x += 16) {
      const dy = Math.sin((x + performance.now() * 0.002 + i * 50) * 0.04) * 2;
      ctx.lineTo(x, y + dy);
    }
    ctx.stroke();
    ctx.beginPath();
  }
  ctx.globalAlpha = 1;
}

function renderHUD() {
  const remaining = Math.max(0, Math.ceil(ROUND_SECONDS - elapsed));
  timerEl.textContent = String(remaining);
}

// Game control
function endGame(didWin, message) {
  if (gameOver) return;
  gameOver = true;
  win = didWin;
  resultTitle.textContent = didWin ? "Victory" : "Game Over";
  resultSub.textContent = message || (didWin ? "You survived 60 seconds!" : "Try again!");
  resultOverlay.classList.remove("hidden");

  best = Math.max(best, score);
  localStorage.setItem("moo_best", String(best));
  bestEl.textContent = `Best: ${best}`;
}

function update(dt) {
  if (!gameStarted || gameOver) return;
  elapsed += dt;

  // Win condition
  if (elapsed >= ROUND_SECONDS) {
    endGame(true, `Survived! Score ${score}`);
    return;
  }

  // World scroll via moving platforms left
  // Move world only when voice above threshold
  const speaking = lastDb >= MIC_THRESHOLD_DB;
  const speed = speaking ? cow.walkSpeed : 0;
  for (let i = 0; i < platforms.length; i++) platforms[i].update(dt, speed);
  // Update free-floating air obstacles
  for (let i = 0; i < airObstacles.length; i++) airObstacles[i].update(dt, speed);
  platforms = platforms.filter(p => p.visible);
  airObstacles = airObstacles.filter(o => o.visible);
  maybeSpawn();

  // Cow physics and collisions
  cow.update(dt, platforms, speaking ? lastDb : 0);
  checkObstacleCollision();
  updateScore();
}

function render() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  renderBackground();
  for (let i = 0; i < platforms.length; i++) platforms[i].render(ctx);
  for (let i = 0; i < airObstacles.length; i++) airObstacles[i].render(ctx);
  cow.render(ctx);
}

function loop(ts) {
  if (!lastTimestamp) lastTimestamp = ts;
  const dt = Math.min(0.033, (ts - lastTimestamp) / 1000);
  lastTimestamp = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Mic setup
async function setupAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert("Microphone permission is required to play.");
    throw e;
  }
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // Speech recognition removed per user request; movement relies on decibel threshold only
}

function getDecibels() {
  if (!analyser || isMuted) return 0;
  const bufferLength = analyser.fftSize;
  const data = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(data);
  // Compute RMS
  let sumSquares = 0;
  for (let i = 0; i < bufferLength; i++) {
    const v = (data[i] - 128) / 128.0;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / bufferLength) + 1e-8;
  // Map to approximate dB scale for gameplay feel (not calibrated SPL)
  const db = 20 * Math.log10(rms) + 100; // shift to ~0..100
  return Math.max(0, Math.min(100, db));
}

function updateMicUI(db) {
  lastDb = db;
  const pct = Math.max(0, Math.min(100, db));
  micFillEl.style.width = `${pct}%`;
}

function micLoop() {
  const db = getDecibels();
  updateMicUI(db);
  // Flight control is handled in update() via lastDb
  requestAnimationFrame(micLoop);
}

// Event wiring
startBtn.addEventListener("click", async () => {
  await setupAudio();
  resetGame();
});

retryBtn.addEventListener("click", () => {
  resetGame();
});

muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  muteBtn.textContent = isMuted ? "🔈" : "🔇";
});

// Initialize spawns and mic loop
maybeSpawn();
micLoop();


