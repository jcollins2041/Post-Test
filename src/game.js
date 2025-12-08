// game.js

// ── Safe, non-colliding storage helpers (shared with index.html) ──
function rtGameLoadUsers() {
  try { return JSON.parse(localStorage.getItem('rt_users') || '{}'); }
  catch { return {}; }
}
function rtGameSaveUsers(u) {
  try { localStorage.setItem('rt_users', JSON.stringify(u)); } catch {}
}
function rtGameGetCurrentUser() {
  try { return JSON.parse(localStorage.getItem('rt_currentUser') || 'null'); }
  catch { return null; }
}

// Legacy helpers (unused in post-test but kept for compatibility)
function rtGamePersistHighScoreIfPossible(newScore) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return;
  const users = rtGameLoadUsers();
  if (!users[curr.username]) return;
  if (typeof users[curr.username].highScore !== 'number' || newScore > users[curr.username].highScore) {
    users[curr.username].highScore = newScore;
    rtGameSaveUsers(users);
  }
}
function rtGamePersistBestStreakIfPossible(newStreak) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return;
  const users = rtGameLoadUsers();
  const u = users[curr.username];
  if (!u) return;
  if (typeof u.highStreak !== 'number' || newStreak > u.highStreak) {
    u.highStreak = newStreak;
    rtGameSaveUsers(users);
  }
}

// New helpers for POST-TEST metrics
//   postAccuracy   – best % accuracy on pre-fires for post-test
//   postBestStreak – best streak during post-test
function rtGamePersistPostAccuracyIfPossible(accPercent) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return;
  const users = rtGameLoadUsers();
  const u = users[curr.username] || {};
  if (typeof u.postAccuracy !== 'number' || accPercent > u.postAccuracy) {
    u.postAccuracy = accPercent;
  }
  users[curr.username] = u;
  rtGameSaveUsers(users);
}
function rtGamePersistPostBestStreakIfPossible(newStreak) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return;
  const users = rtGameLoadUsers();
  const u = users[curr.username] || {};
  if (typeof u.postBestStreak !== 'number' || newStreak > u.postBestStreak) {
    u.postBestStreak = newStreak;
  }
  users[curr.username] = u;
  rtGameSaveUsers(users);
}

// ── Public API ───────────────────────────────────────────────────────
function initGame(playerName, isLeftHanded = true) {
  console.log("Starting game for", playerName);
  window.playerName = playerName;
  window.isLeftHanded = !!isLeftHanded;

  const playerImg = new Image();
  const alienImg = new Image();
  let loaded = 0;

  function tryStart() {
    if (++loaded === 2) startGame(playerImg, alienImg);
  }

  [playerImg, alienImg].forEach(img => {
    img.onload = tryStart;
    img.onerror = tryStart;
  });

  playerImg.src = 'img/player.png';
  alienImg.src = 'img/alien.png';
}

window.initGame = initGame;

// ── Internal: once assets are loaded, kick off the actual game ──────
function startGame(playerImg, alienImg) {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  // Pause & round UI refs
  const pauseMenu = document.getElementById('pauseMenu');
  const btnPauseResume = document.getElementById('btn-pause-resume');
  const btnPauseBack   = document.getElementById('btn-pause-back');

  const roundMenu       = document.getElementById('roundMenu');
  const roundMenuTitle  = document.getElementById('roundMenu-title');
  const roundMenuBody   = document.getElementById('roundMenu-body');
  const btnRoundContinue= document.getElementById('btn-round-continue');
  const btnRoundExit    = document.getElementById('btn-round-exit');

  const cols = 12;
  let cellWidth;
  let ship;

  // --- Speed tuning (only used for enemy descent) ---
  const SPEED = {
    BULLET_VY: -18,
    ENEMY_SPEED_MULT: 1.9
  };

  // Post-test structure: 4 rounds × 50 sequences
  const TRIALS_PER_ROUND = 50;
  const TOTAL_ROUNDS     = 4;
  const TOTAL_TRIALS     = TRIALS_PER_ROUND * TOTAL_ROUNDS;

  let paused = false;
  let pausedSnapshot = { withinPhase: false, quarter: null, hadWaiting: false };
  let betweenRounds = false;
  let experimentDone = false;

  // Trial / accuracy tracking
  let roundIndex = 0;        // 0..3
  let trialInRound = 0;      // 0..50 within round
  let totalTrials = 0;       // 0..200 total
  let correctPrefires = 0;   // number of correct pre-fires (hits)
  let currentTrial = null;   // {resolved, hit}

  // default in-memory best accuracy & best streak
  if (typeof window.bestAccuracy !== 'number') window.bestAccuracy = 0;
  if (typeof window.bestStreak   !== 'number') window.bestStreak   = 0;

  // Load saved POST-TEST accuracy / best streak for the current user
  (function initPostStatsFromStorage(){
    const curr = rtGameGetCurrentUser();
    if (curr) {
      const users = rtGameLoadUsers();
      const rec = users[curr.username];
      if (rec && typeof rec.postAccuracy === 'number') {
        window.bestAccuracy = rec.postAccuracy;
      }
      if (rec && typeof rec.postBestStreak === 'number') {
        window.bestStreak = rec.postBestStreak;
      }
    }
  })();

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cellWidth = canvas.width / cols;
    if (ship) ship.updatePos();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Middle cell index of each quarter (0..3)
  const groupOffsets = [1, 4, 7, 10];

  // ── Quarter tone parameters (Gaussian per quarter) ─────────────────
  const quarterToneParams = [
    { min: 427.65, max: 508.57, peak: 466.16 }, // Q1
    { min: 359.61, max: 427.65, peak: 392.00 }, // Q2
    { min: 302.40, max: 359.61, peak: 329.63 }, // Q3
    { min: 254.29, max: 302.40, peak: 277.18 }  // Q4
  ];

  // Grouping rules by LEVEL (we freeze this at Lv7 for post-test → exact everywhere)
  function prefireIsGroupedForQuarter(qi, lvl) {
    if (lvl < 4) return true;
    if (lvl < 6) return (qi === 1 || qi === 3);
    return false;
  }
  const TEST_LEVEL_INDEX = 7; // no grouping, exact quarter match

  // ── Audio + Piano Sample Loader (WAV-only) ─────────────────────────
  const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const SAMPLE_PATH = 'audio';
  const PIANO_SAMPLE_LIST = [
    261.63, 277.18, 293.66, 311.13, 329.63, 349.23,
    369.99, 392.00, 415.30, 440.00, 466.16, 493.88
  ];
  const piano = { buffers: new Map(), ready: false };

  const pianoComp = audioCtx.createDynamicsCompressor();
  pianoComp.threshold.setValueAtTime(-30, audioCtx.currentTime);
  pianoComp.knee.setValueAtTime(30, audioCtx.currentTime);
  pianoComp.ratio.setValueAtTime(3, audioCtx.currentTime);
  pianoComp.attack.setValueAtTime(0.003, audioCtx.currentTime);
  pianoComp.release.setValueAtTime(0.25, audioCtx.currentTime);

  const pianoMaster = audioCtx.createGain();
  pianoMaster.gain.setValueAtTime(2.3, audioCtx.currentTime);
  pianoComp.connect(pianoMaster).connect(audioCtx.destination);

  function decodeAudioDataP(ab) {
    return new Promise((resolve, reject) => {
      audioCtx.decodeAudioData(ab, resolve, reject);
    });
  }

  let samplesLoadPromise = null;
  function loadPianoSamples() {
    if (samplesLoadPromise) return samplesLoadPromise;
    samplesLoadPromise = (async () => {
      let ok = 0;
      for (const f of PIANO_SAMPLE_LIST) {
        const fname = f.toFixed(2);
        const url = `${SAMPLE_PATH}/${fname}.wav`;
        try {
          const res = await fetch(url);
          if (!res.ok) { console.warn(`[piano] fetch failed ${res.status}: ${url}`); continue; }
          const arr = await res.arrayBuffer();
          const buf = await decodeAudioDataP(arr);
          piano.buffers.set(f, buf);
          ok++;
        } catch (err) {
          console.warn('[piano] sample failed to load:', url, err);
        }
      }
      piano.ready = piano.buffers.size > 0;
      console.log(`Piano samples loaded: ${ok}/${PIANO_SAMPLE_LIST.length}`, { loaded: [...piano.buffers.keys()] });
      window.PIANO_DEBUG = piano;
    })();
    return samplesLoadPromise;
  }

  function waitForPianoReady(timeoutMs = 20000) {
    return new Promise(resolve => {
      if (piano.ready) return resolve();
      const start = performance.now();
      const id = setInterval(() => {
        if (piano.ready || (performance.now() - start) > timeoutMs) {
          clearInterval(id);
          resolve();
        }
      }, 25);
    });
  }

  // ── RNG & frequency sampling by QUARTER ────────────────────────────
  function randn_bm() {
    let u=0,v=0;
    while(!u) u=Math.random();
    while(!v) v=Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function sampleFreqForQuarter(qi) {
    const { min, max, peak } = quarterToneParams[qi];
    const sigma = (max - min) / 6;
    let freq = peak + randn_bm() * sigma;
    freq = Math.max(min, Math.min(max, freq));
    const midRange = (min + max) / 2;
    const shifts = (freq > midRange) ? [-3, -2, -2, 0, 2] : [3, 2, 2, 0, -2];
    const octaveShift = shifts[Math.floor(Math.random() * shifts.length)];
    return freq * Math.pow(2, octaveShift);
  }

  // ── Tone timing controls ───────────────────────────────────────────
  const noteDur = 0.95;
  const NEXT_NOTE_LEAD = 0.35;
  const toneCloudDuration = 2;

  function getClosestSample(targetHz) {
    if (piano.buffers.size === 0) return null;
    const bases = [...piano.buffers.keys()].sort((a,b)=>a-b);
    let t = targetHz;
    const minHz = bases[0], maxHz = bases[bases.length-1];
    while (t < minHz) t *= 2;
    while (t >= maxHz*2) t /= 2;
    let best = null, bestDist = Infinity;
    for (const b of bases) {
      const d = Math.abs(Math.log2(t / b));
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return { baseHz: best, buf: piano.buffers.get(best), tunedTarget: t };
  }

  function playPianoTone(targetHz, dur = noteDur, startTime = audioCtx.currentTime) {
    if (!piano.ready || piano.buffers.size === 0) {
      console.warn('[piano] not ready yet; tone skipped');
      return;
    }
    const choice = getClosestSample(targetHz);
    if (!choice) return;

    const rate = choice.tunedTarget ? (choice.tunedTarget / choice.baseHz) : (targetHz / choice.baseHz);

    const src = audioCtx.createBufferSource();
    src.buffer = choice.buf;
    src.playbackRate.setValueAtTime(rate, startTime);
    src.loop = false;

    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    const startCut = Math.min(9000, Math.max(1500, targetHz * 3));
    const endCut   = Math.min(6000, Math.max( 900, targetHz * 1.2));
    lp.frequency.setValueAtTime(startCut, startTime);
    lp.frequency.exponentialRampToValueAtTime(endCut, startTime + dur * 0.8);
    lp.Q.value = 0.7;

    const g = audioCtx.createGain();
    const A = 0.006, D = 0.08, R = 0.10, S = 0.80;
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.exponentialRampToValueAtTime(1.15, startTime + A);
    g.gain.exponentialRampToValueAtTime(S, startTime + A + D);
    const sustainEnd = Math.max(startTime + A + D + 0.02, startTime + dur - R);
    g.gain.setValueAtTime(S, sustainEnd);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    src.connect(lp).connect(g).connect(pianoComp);
    src.start(startTime);
    src.stop(startTime + dur + 0.02);
  }

  function playStatic(d = 2) {
    const sr = audioCtx.sampleRate;
    const len = sr * d;
    const buf = audioCtx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.02;
    const src = audioCtx.createBufferSource();
    const g = audioCtx.createGain();
    src.buffer = buf; g.gain.value = 0.1;
    src.connect(g).connect(audioCtx.destination);
    src.start();
  }

  function playLaser() {
    const now = audioCtx.currentTime;
    const size = audioCtx.sampleRate * 0.1;
    const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const src = audioCtx.createBufferSource(), g = audioCtx.createGain();
    g.gain.setValueAtTime(1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start(now);
  }

  function playPew() {
    const now = audioCtx.currentTime;
    const size = audioCtx.sampleRate * 0.3;
    const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.25;
    const src = audioCtx.createBufferSource(), g = audioCtx.createGain();
    g.gain.setValueAtTime(1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start(now);
  }

  function playCloudTone(freq, dur, startTime) {
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(0.15, startTime + 0.005);
    g.gain.linearRampToValueAtTime(0, startTime + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + dur);
  }

  function playToneCloud(dur) {
    const start = audioCtx.currentTime, end = start + dur;
    for (let t = start; t < end; t += 1/3) playCloudTone(440, 0.1, t);
    const rate = 15, interval = 1 / rate;
    for (let t = start; t < end; t += interval) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      const oct = 0.5 + Math.random() * 2;
      playCloudTone(440 * Math.pow(2, sign * oct), 0.1, t);
    }
  }

  // ── Score multiplier (internal only; not used for leaderboard) ────
  function getKillPointsForStreak(streakValue) {
    const base = 100;
    const s = Math.max(0, streakValue || 0);
    const multiplier = Math.pow(1.25, s);
    return Math.round(base * multiplier);
  }

  // ── NOTE SCHEDULER ─────────────────────────────────────────────────
  let toneLoopTimer = null;
  let lastToneHz = null;

  function centsBetween(a, b) { return Math.abs(1200 * Math.log2(a / b)); }
  function pickNonRepeatingFreqForQuarter(qi) {
    let tries = 0;
    while (tries < 8) {
      const f = sampleFreqForQuarter(qi);
      if (lastToneHz == null || centsBetween(f, lastToneHz) >= 25) {
        lastToneHz = f; return f;
      }
      tries++;
    }
    lastToneHz = sampleFreqForQuarter(qi);
    return lastToneHz;
  }

  function startToneSequence(qi) {
    stopToneSequence();
    if (!piano.ready) { console.warn('[piano] tried to start before ready'); return; }
    const IOI = Math.max(0.03, noteDur - NEXT_NOTE_LEAD);
    const scheduleNext = (startTime) => {
      const f = pickNonRepeatingFreqForQuarter(qi);
      playPianoTone(f, noteDur, startTime);
      const nextStart = startTime + IOI;
      const delayMs   = Math.max(0, (nextStart - audioCtx.currentTime - 0.01) * 1000);
      toneLoopTimer = setTimeout(() => scheduleNext(nextStart), delayMs);
    };
    const firstStart = audioCtx.currentTime + 0.02;
    scheduleNext(firstStart);
  }

  function stopToneSequence() {
    if (toneLoopTimer) { clearTimeout(toneLoopTimer); toneLoopTimer = null; }
    lastToneHz = null;
  }

  // ── Timers to fully stop activity ──────────────────────────────────
  let prefireTimer = null;
  let spawnTimer   = null;
  let cloudTimerId = null;
  let afterCloudTimerId = null;

  function clearAllTimers() {
    if (prefireTimer) { clearTimeout(prefireTimer); prefireTimer = null; }
    if (spawnTimer)   { clearTimeout(spawnTimer);   spawnTimer = null; }
    if (cloudTimerId) { clearTimeout(cloudTimerId); cloudTimerId = null; }
    if (afterCloudTimerId) { clearTimeout(afterCloudTimerId); afterCloudTimerId = null; }
  }

  // ── Pause helpers ──────────────────────────────────────────────────
  function togglePause() {
    if (experimentDone || betweenRounds) return;

    if (!paused) {
      pausedSnapshot.withinPhase = (withinPhase && !enemy);
      pausedSnapshot.quarter     = expectedQuarter;
      pausedSnapshot.hadWaiting  = (waiting && !enemy);
    }

    paused = !paused;

    if (paused) {
      clearAllTimers();
      stopToneSequence();
      audioCtx.suspend().catch(()=>{});
      if (pauseMenu) pauseMenu.style.display = 'flex';
    } else {
      if (pauseMenu) pauseMenu.style.display = 'none';
      audioCtx.resume().catch(()=>{});

      if (pausedSnapshot.withinPhase && !enemy) {
        withinPhase = true;
        waiting = true;
        startToneSequence(pausedSnapshot.quarter);

        if (spawnTimer) { clearTimeout(spawnTimer); }
        spawnTimer = setTimeout(()=>{
          if (experimentDone || paused) return;
          if (!phaseShot) streak = 0;
          const spawnCell = groupOffsets[pausedSnapshot.quarter];
          enemy = new Enemy(spawnCell, levels[TEST_LEVEL_INDEX].s);
          waiting = false;
          withinPhase = false;
        }, 4000);
        return;
      }

      if (waiting && !enemy) waiting = false;
      scheduleWave();
    }
  }

  function getAccuracyPercent() {
    return totalTrials ? (correctPrefires / totalTrials) * 100 : 0;
  }

  function exitToLogin() {
    // Persist best accuracy and best streak for this post-test session
    const acc = getAccuracyPercent();
    if (acc > (window.bestAccuracy || 0)) {
      window.bestAccuracy = acc;
      rtGamePersistPostAccuracyIfPossible(window.bestAccuracy);
    }

    if (bestStreak > (window.bestStreak || 0)) {
      window.bestStreak = bestStreak;
      rtGamePersistPostBestStreakIfPossible(window.bestStreak);
    }

    over = true;
    paused = false;
    betweenRounds = false;
    experimentDone = true;

    clearAllTimers();
    stopToneSequence();
    audioCtx.suspend().catch(()=>{});

    if (pauseMenu) pauseMenu.style.display = 'none';
    if (roundMenu) roundMenu.style.display = 'none';
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = 'none';

    if (window._rtKeyHandlerRef) {
      document.removeEventListener('keydown', window._rtKeyHandlerRef);
      window._rtKeyHandlerRef = null;
    }

    canvas.style.display = 'none';
    const intro = document.getElementById('intro');
    const leaderboard = document.getElementById('leaderboard');
    const auth = document.getElementById('auth');
    if (intro) intro.style.display = 'none';
    if (leaderboard) leaderboard.style.display = 'none';
    if (auth) auth.style.display = 'flex';
  }

  // ── Entities (still exist, but will not be drawn) ──────────────────
  class Ship {
    constructor() {
      this.group = 1;
      this.blockOffset = 0;
      this.w = cellWidth * 2.5;
      const ratio = playerImg.naturalWidth
        ? playerImg.naturalHeight / playerImg.naturalWidth
        : 0.5;
      this.h = this.w * ratio;
      this.updatePos();
    }
    updatePos() {
      const baseMid = groupOffsets[this.group];
      this.cell = baseMid;
      this.x = (this.cell + 0.5) * cellWidth;
      this.y = canvas.height - this.h / 2;
    }
    draw() {
      // NO DRAWING (white screen post-test)
    }
    move(d) {
      this.group = Math.max(0, Math.min(groupOffsets.length - 1, this.group + d));
      this.blockOffset = 0;
      this.updatePos();
    }
  }

  class Bullet {
    constructor(x,y) {
      this.x = x;
      this.y = y;
      this.r = 4;
      this.vy = SPEED.BULLET_VY;
    }
    update() { this.y += this.vy; }
    draw() {
      // NO DRAWING
    }
    off() { return this.y < 0; }
  }

  class Enemy {
    constructor(cellIndex,s) {
      this.x=(cellIndex+0.5)*cellWidth;
      this.y=-20;
      this.vy = (s/60) * SPEED.ENEMY_SPEED_MULT;
      this.r=16;
    }
    update() { this.y += this.vy; }
    draw() {
      // NO DRAWING
    }
    hit() {
      return this.y + this.r >= ship.y - ship.h/2;
    }
  }

  // Speeds table retained for Enemy speed
  const levels = [
    {s:50,w:['topLeft','bottomRight']},
    {s:60,w:['topLeft','bottomRight']},
    {s:70,w:['topLeft','bottomRight','bottomLeft']},
    {s:80,w:['topLeft','bottomRight','bottomLeft']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']},
    {s:80,w:['topLeft','bottomRight']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']}
  ];

  let bullets,enemy,lvl,score,waiting,over,inTransition,
      expectedQuarter,withinPhase,phaseShot,streak=0,
      explosions=[],effects=[];
  let bestStreak = window.bestStreak || 0;

  const overlay=document.getElementById('overlay'),
        transition=document.getElementById('transition');

  function initState(){
    ship=new Ship();
    bullets=[];
    enemy=null;
    score=0;
    lvl=TEST_LEVEL_INDEX;
    waiting=false;
    over=false;
    inTransition=false;
    streak=0;
    explosions=[];
    effects=[];
    roundIndex = 0;
    trialInRound = 0;
    totalTrials = 0;
    correctPrefires = 0;
    betweenRounds = false;
    experimentDone = false;
    currentTrial = null;
  }

  function openRoundMenu(isFinal=false) {
    if (!roundMenu) return;
    const acc = getAccuracyPercent();
    if (roundMenuTitle) {
      roundMenuTitle.textContent = isFinal
        ? 'Post-Test Complete'
        : `Round ${roundIndex + 1} Complete`;
    }
    if (roundMenuBody) {
      roundMenuBody.textContent =
        `Correct pre-fires: ${correctPrefires} of ${totalTrials} ` +
        `(${acc.toFixed(1)}%).\n` +
        `Current streak: ${streak}. Best streak: ${bestStreak}.`;
    }
    if (btnRoundContinue) {
      btnRoundContinue.textContent = isFinal ? 'Back to Login' : 'Continue';
    }
    if (btnRoundExit) {
      btnRoundExit.style.display = isFinal ? 'none' : 'inline-block';
    }
    roundMenu.style.display = 'flex';
  }

  function finishTrialAndMaybeContinue() {
    if (!currentTrial) currentTrial = {};
    if (!currentTrial.resolved) {
      currentTrial.resolved = true;
      totalTrials++;
      trialInRound++;
      if (currentTrial.hit) correctPrefires++;
    }

    waiting = false;
    enemy = null;

    if (totalTrials >= TOTAL_TRIALS) {
      experimentDone = true;
      betweenRounds = true;
      openRoundMenu(true);

      // Persist best accuracy & streak as soon as the test completes
      const acc = getAccuracyPercent();
      if (acc > (window.bestAccuracy || 0)) {
        window.bestAccuracy = acc;
        rtGamePersistPostAccuracyIfPossible(window.bestAccuracy);
      }
      if (bestStreak > (window.bestStreak || 0)) {
        window.bestStreak = bestStreak;
        rtGamePersistPostBestStreakIfPossible(window.bestStreak);
      }

      console.log('Post-test complete:', {
        totalTrials,
        correctPrefires,
        accuracy: getAccuracyPercent()
      });
      return;
    }

    if (trialInRound >= TRIALS_PER_ROUND) {
      betweenRounds = true;
      openRoundMenu(false);
      return;
    }

    scheduleWave();
  }

  if (btnRoundContinue) {
    btnRoundContinue.addEventListener('click', () => {
      if (experimentDone) {
        roundMenu.style.display = 'none';
        exitToLogin();
        return;
      }
      roundMenu.style.display = 'none';
      if (trialInRound >= TRIALS_PER_ROUND) {
        roundIndex++;
        trialInRound = 0;
      }
      betweenRounds = false;
      scheduleWave();
    });
  }
  if (btnRoundExit) {
    btnRoundExit.addEventListener('click', () => {
      roundMenu.style.display = 'none';
      exitToLogin();
    });
  }

  function initLoop(){
    initState();
    document.addEventListener('keydown', unlock, { once:true });
    requestAnimationFrame(loop);
  }

  async function unlock(){
    try {
      await audioCtx.resume();
    } catch {}
    loadPianoSamples();
    scheduleWave();
  }

  function scheduleWave() {
    if (over || waiting || enemy || inTransition || paused || betweenRounds || experimentDone) return;
    if (totalTrials >= TOTAL_TRIALS) return;

    stopToneSequence();

    waiting = true;
    withinPhase = false;
    phaseShot = false;
    currentTrial = { resolved: false, hit: false };

    expectedQuarter = Math.floor(Math.random() * 4);
    const spawnCell = groupOffsets[expectedQuarter];

    playStatic(2);
    prefireTimer = setTimeout(async ()=>{
      if (inTransition || over || paused || betweenRounds || experimentDone) return;
      await waitForPianoReady();
      withinPhase = true;

      startToneSequence(expectedQuarter);

      spawnTimer = setTimeout(()=>{
        if (over || paused || betweenRounds || experimentDone) return;
        if (!phaseShot) {
          streak = 0;            // miss → break streak
          currentTrial.hit = false;
        }
        enemy = new Enemy(spawnCell, levels[TEST_LEVEL_INDEX].s);
        waiting = false;
        withinPhase = false;
      }, 4000);
    }, 2000);
  }

  // restart routine (kept but rarely used in post-test)
  function restartGame() {
    clearAllTimers();
    stopToneSequence();
    if (overlay) overlay.style.display='none';

    paused = false;
    if (pauseMenu) pauseMenu.style.display = 'none';

    initState();
    audioCtx.resume().catch(()=>{});

    requestAnimationFrame(loop);
    scheduleWave();
  }

  function loop(){
    if (over) return;

    // While paused or between rounds, keep RAF alive and white screen
    if (paused || betweenRounds) {
      ctx.fillStyle = 'white';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      requestAnimationFrame(loop);
      return;
    }

    // White screen, no visual stimuli
    ctx.fillStyle = 'white';
    ctx.fillRect(0,0,canvas.width,canvas.height);

    // Update entities without drawing
    bullets?.forEach(b=>{b.update();});
    if (enemy) {
      enemy.update();
      // If enemy reaches the ship line → treat as a miss, end trial
      if (enemy.hit()) {
        enemy = null;
        stopToneSequence();
        clearAllTimers();
        finishTrialAndMaybeContinue();
        requestAnimationFrame(loop);
        return;
      }
    }

    bullets = (bullets || []).filter(b=>{
      if (b.off()) return false;
      if (enemy && Math.hypot(enemy.x - b.x, enemy.y - b.y) < enemy.r + b.r) {
        // Kill: counted as a miss unless there was already a correct pre-fire.
        const killPoints = getKillPointsForStreak(streak);
        score += killPoints;

        enemy = null;
        stopToneSequence();
        waiting = true;

        cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
        afterCloudTimerId = setTimeout(() => {
          if (over || experimentDone) return;
          finishTrialAndMaybeContinue();
        }, 1000 + toneCloudDuration * 1000 + 1000);

        return false;
      }
      return true;
    });

    if (!enemy && !waiting && !inTransition && !betweenRounds && !experimentDone) {
      scheduleWave();
    }

    requestAnimationFrame(loop);
  }

  // Hook pause buttons
  if (btnPauseResume) btnPauseResume.addEventListener('click', () => { if (paused) togglePause(); });
  if (btnPauseBack)   btnPauseBack.addEventListener('click', () => { exitToLogin(); });

  // Movement & shooting parameters (dedup across restarts)
  if (window._rtKeyHandlerRef) {
    document.removeEventListener('keydown', window._rtKeyHandlerRef);
  }

  const keyHandler = (e) => {
    const kRaw = e.key || '';
    const k    = kRaw.toLowerCase();

    // Pause toggle on Esc
    if (e.key === 'Escape' || k === 'escape') { togglePause(); return; }

    if (paused || betweenRounds || experimentDone) return;

    if (k === 'r' && over) { restartGame(); return; }

    // Quarter movement: left-handed 1–4, right-handed P [ ] \
    const LEFT_KEYS  = new Map([['1',0], ['2',1], ['3',2], ['4',3]]);
    const RIGHT_KEYS = new Map([['p',0], ['[',1], [']',2], ['\\',3]]);

    let movementIndex;
    if (window.isLeftHanded) {
      movementIndex = LEFT_KEYS.get(kRaw);
    } else {
      movementIndex = RIGHT_KEYS.get(kRaw) ?? RIGHT_KEYS.get(k);
    }
    if (movementIndex !== undefined) {
      ship.group = movementIndex;
      ship.blockOffset = 0;
      ship.updatePos();
      return;
    }

    if (k === 'c') {
      streak++;
      if (streak > bestStreak) {
        bestStreak = streak;
        window.bestStreak = bestStreak;
      }
      return;
    }

    // ── 1) PREDICTION PHASE (pre-fire) — quarter-based ───────────────
    if (withinPhase && !enemy) {
      const alienQuarter  = expectedQuarter;
      const playerQuarter = ship.group;
      const groupedPhase  = prefireIsGroupedForQuarter(alienQuarter, TEST_LEVEL_INDEX);

      // Wrong quarter on F → miss, break streak
      if (k === 'f' && playerQuarter !== alienQuarter) {
        streak = 0;
        withinPhase = false;
        currentTrial.hit = false;
        return;
      }

      if (groupedPhase) {
        // (For TEST_LEVEL_INDEX=7 this is false; included for completeness)
        if (k !== 'f' || playerQuarter !== alienQuarter) return;

        score += 75;
        streak++;
        if (streak > bestStreak) {
          bestStreak = streak;
          window.bestStreak = bestStreak;
        }
        phaseShot = true;
        currentTrial.hit = true;
        stopToneSequence();
        clearTimeout(spawnTimer);
        playPew();
        const spawnCell = groupOffsets[alienQuarter];
        effects.push({ type: 'precogScreenFlash', cell: spawnCell, startTime: Date.now(), duration: 600 });
        waiting = true; withinPhase = false;

        cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
        afterCloudTimerId = setTimeout(() => {
          if (!over && !experimentDone) {
            finishTrialAndMaybeContinue();
          }
        }, (1 + toneCloudDuration + 1) * 1000);
        return;
      }

      // Exact phases (TEST_LEVEL_INDEX=7): require correct quarter
      if (k === 'f') {
        if (playerQuarter === alienQuarter) {
          score += 75;
          streak++;
          if (streak > bestStreak) {
            bestStreak = bestStreak = streak;
            window.bestStreak = bestStreak;
          }
          phaseShot = true;
          currentTrial.hit = true;
          stopToneSequence();
          clearTimeout(spawnTimer);
          playPew();
          const spawnCell = groupOffsets[alienQuarter];
          effects.push({ type: 'precogScreenFlash', cell: spawnCell, startTime: Date.now(), duration: 600 });
          waiting = true; withinPhase = false;

          cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
          afterCloudTimerId = setTimeout(() => {
            if (!over && !experimentDone) {
              finishTrialAndMaybeContinue();
            }
          }, (1 + toneCloudDuration + 1) * 1000);
        } else {
          streak = 0;
          withinPhase = false;
          currentTrial.hit = false;
        }
        return;
      }
      return;
    }

    // ── 2) REGULAR SHOOTING — ALWAYS TRIPLE SHOT (counts as miss) ────
    if (k === 'f') {
      const base = groupOffsets[ship.group];
      [-1, 0, 1].forEach(off => {
        const c = base + off;
        playLaser();
        bullets = bullets || [];
        bullets.push(new Bullet((c + 0.5) * cellWidth, ship.y - ship.h / 2));
      });
    }
  };

  document.addEventListener('keydown', keyHandler);
  window._rtKeyHandlerRef = keyHandler;

  if (btnPauseResume) btnPauseResume.addEventListener('click', () => { if (paused) togglePause(); });
  if (btnPauseBack)   btnPauseBack.addEventListener('click', () => { exitToLogin(); });

  // ── finally, kick off the animation loop ────────────────────────────
  initLoop();
}
