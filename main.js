"use strict";

// Constants
const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const FLOOR_Y = GAME_HEIGHT * 0.75; // Ocean baseline
const ROUND_SECONDS = 60;
const MIC_THRESHOLD_DB = 45; // >=45 dB triggers jump
const MIN_OBSTACLES_PER_ROUND = 10;

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
    this.jumpBase = 520; // base jump velocity for 45 dB
    this.jumpScale = 14; // extra per dB over threshold
    this.walkSpeed = 180; // px/s world scroll speed
    this.onGround = false;
    this.inWater = false;
  }

  tryJump(db) {
    if (db < MIC_THRESHOLD_DB) return;
    const over = Math.max(0, db - MIC_THRESHOLD_DB);
    const jumpVelocity = this.jumpBase + over * this.jumpScale;
    if (this.onGround) {
      this.velY = -jumpVelocity;
      this.onGround = false;
    }
  }

  update(dt, platforms) {
    this.velY += this.gravity * dt;
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
    this.obstacle = null;
    this.scored = false;
  }

  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) this.visible = false;
    if (this.obstacle) this.obstacle.update(dt, speed);
  }

  render(ctx) {
    // Tower island: brown base + green top
    ctx.save();
    ctx.fillStyle = "#854d0e";
    ctx.fillRect(this.x, this.y, this.width, this.height);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(this.x - 4, this.y - 10, this.width + 8, 14);
    ctx.restore();

    if (this.obstacle) this.obstacle.render(ctx);
  }
}

class Obstacle {
  constructor(platform) {
    this.platform = platform;
    this.width = 24 + Math.floor(rng() * 18);
    this.height = 20 + Math.floor(rng() * 20);
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

// World
let cow = new Cow();
let platforms = [];
let nextPlatformX = GAME_WIDTH * 0.6;
let obstacleCountThisRound = 0;

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
  cow = new Cow();
  centerOverlay.classList.add("hidden");
  resultOverlay.classList.add("hidden");
}

// Platform/Obstacle generation
function maybeSpawn() {
  while (nextPlatformX < GAME_WIDTH * 1.6) {
    const width = 140 + Math.floor(rng() * 200);
    const gap = 100 + Math.floor(rng() * 260); // Unequal gaps
    const p = new Platform(nextPlatformX, width);

    // At least 10 obstacles in 60s: bias obstacle probability to guarantee
    const remainingTime = Math.max(0, ROUND_SECONDS - elapsed);
    const need = Math.max(0, MIN_OBSTACLES_PER_ROUND - obstacleCountThisRound);
    const estPlatformsRemaining = Math.max(need, Math.ceil(remainingTime));
    const forceProbability = need > 0 ? Math.min(0.8, need / Math.max(1, estPlatformsRemaining)) : 0.25;
    if (rng() < forceProbability) {
      p.hasObstacle = true;
      p.obstacle = new Obstacle(p);
      obstacleCountThisRound += 1;
    }

    platforms.push(p);
    nextPlatformX += width + gap;
  }
}

// Collision checks
function checkObstacleCollision() {
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    if (!p.visible || !p.obstacle) continue;
    const o = p.obstacle;
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
      if (p.hasObstacle) score += 1;
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
  const speed = cow.walkSpeed;
  for (let i = 0; i < platforms.length; i++) {
    platforms[i].update(dt, speed);
  }
  platforms = platforms.filter(p => p.visible);
  maybeSpawn();

  // Cow physics and collisions
  cow.update(dt, platforms);
  checkObstacleCollision();
  updateScore();
}

function render() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  renderBackground();
  for (let i = 0; i < platforms.length; i++) platforms[i].render(ctx);
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
  if (gameStarted && !gameOver) cow.tryJump(db);
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


