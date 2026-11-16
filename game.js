// Void Strike — raycasting FPS. Plain canvas JS, no assets.
// WASD move, mouse drag to look, click/Space to shoot. Touch: left drag moves, right drag looks, FIRE shoots.
(function () {
  'use strict';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = canvas.width;
  var H = canvas.height;
  var FOV = Math.PI / 3; // 60 degrees
  var RAYS = 160;
  var WIN_KILLS = 25;
  var WAVE_COUNTS = [4, 5, 5, 5, 6];

  var scoreEl = document.getElementById('hud-score');
  var waveEl = document.getElementById('hud-wave');
  var hpEl = document.getElementById('hud-hp');
  var enemiesEl = document.getElementById('hud-enemies');
  var startBtn = document.getElementById('start-btn');
  var fireBtn = document.getElementById('fire-btn');

  var MAP = [
    '1111111111111111',
    '1000000000000001',
    '1011100010111101',
    '1000100000100001',
    '1010101110101101',
    '1000001000000001',
    '1110101011110101',
    '1000100000010001',
    '1011101111010101',
    '1000000001000001',
    '1010111101011101',
    '1000100000000101',
    '1110101110100101',
    '1000001000000001',
    '1011100010111101',
    '1111111111111111'
  ];
  var SPAWNS = [
    { x: 14.5, y: 1.5 }, { x: 1.5, y: 14.5 }, { x: 14.5, y: 14.5 },
    { x: 8.5, y: 1.5 }, { x: 1.5, y: 8.5 }, { x: 14.5, y: 8.5 }
  ];

  var state = 'title'; // title | playing | paused | won | over
  var score = 0;
  var kills = 0;
  var hp = 100;
  var wave = 1;
  var best = 0;
  try { best = parseInt(localStorage.getItem('void-strike-best') || '0', 10) || 0; } catch (e) { best = 0; }
  var muted = false;
  var enemies = [];
  var toSpawn = 0;
  var spawnTimer = 0;
  var betweenWaves = 0;
  var shootCooldown = 0;
  var shootFlash = 0;
  var hitMarker = 0;
  var hurtFlash = 0;
  var bob = 0;

  var player = { x: 1.5, y: 1.5, angle: 0, speed: 3.4 };
  var keys = {};

  var audioCtx = null;
  function beep(freq, dur, type, vol) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = vol || 0.07;
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* sound is optional */ }
  }

  function isWall(x, y) {
    var mx = Math.floor(x), my = Math.floor(y);
    if (mx < 0 || my < 0 || my >= MAP.length || mx >= MAP[0].length) return true;
    return MAP[my].charAt(mx) === '1';
  }

  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // DDA raycast. Returns {dist, side} where side 0 = x-side, 1 = y-side.
  function castRay(angle) {
    var dirX = Math.cos(angle), dirY = Math.sin(angle);
    var mapX = Math.floor(player.x), mapY = Math.floor(player.y);
    var deltaX = Math.abs(1 / (dirX || 0.00001));
    var deltaY = Math.abs(1 / (dirY || 0.00001));
    var stepX, stepY, sideX, sideY;
    if (dirX < 0) { stepX = -1; sideX = (player.x - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - player.x) * deltaX; }
    if (dirY < 0) { stepY = -1; sideY = (player.y - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - player.y) * deltaY; }
    var side = 0, guard = 0;
    while (guard++ < 64) {
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else { sideY += deltaY; mapY += stepY; side = 1; }
      if (mapX < 0 || mapY < 0 || mapY >= MAP.length || mapX >= MAP[0].length) return { dist: 20, side: side };
      if (MAP[mapY].charAt(mapX) === '1') {
        var dist = side === 0 ? sideX - deltaX : sideY - deltaY;
        return { dist: Math.max(0.05, dist), side: side };
      }
    }
    return { dist: 20, side: side };
  }

  function spawnEnemy() {
    var s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
    // Don't spawn right on top of the player.
    var dx = s.x - player.x, dy = s.y - player.y;
    if (dx * dx + dy * dy < 9) s = SPAWNS[(Math.floor(Math.random() * SPAWNS.length) + 3) % SPAWNS.length];
    enemies.push({
      x: s.x + (Math.random() - 0.5) * 0.4,
      y: s.y + (Math.random() - 0.5) * 0.4,
      hp: 100,
      speed: 1.05 + wave * 0.14 + Math.random() * 0.25,
      attack: 0,
      wobble: Math.random() * Math.PI * 2
    });
  }

  function startWave(n) {
    wave = n;
    toSpawn = WAVE_COUNTS[n - 1];
    spawnTimer = 0.5;
    updateHud();
  }

  function reset() {
    score = 0; kills = 0; hp = 100;
    enemies = []; toSpawn = 0; betweenWaves = 0;
    shootCooldown = 0; shootFlash = 0; hitMarker = 0; hurtFlash = 0;
    player.x = 1.5; player.y = 1.5; player.angle = 0;
    startWave(1);
  }

  function startGame() {
    reset();
    state = 'playing';
    startBtn.textContent = 'Restart';
    beep(520, 0.12, 'square', 0.06);
  }

  function endGame(won) {
    state = won ? 'won' : 'over';
    if (score > best) {
      best = score;
      try { localStorage.setItem('void-strike-best', String(best)); } catch (e) {}
    }
    if (won) { beep(660, 0.15, 'sine', 0.09); setTimeout(function () { beep(990, 0.25, 'sine', 0.09); }, 160); }
    else beep(140, 0.4, 'sawtooth', 0.08);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function updateHud() {
    scoreEl.textContent = 'Score: ' + score;
    waveEl.textContent = 'Wave: ' + wave + '/5';
    hpEl.textContent = 'HP: ' + Math.max(0, Math.ceil(hp));
    enemiesEl.textContent = 'Drones: ' + (enemies.length + toSpawn);
  }

  function tryMove(nx, ny) {
    if (!isWall(nx, player.y)) player.x = nx;
    if (!isWall(player.x, ny)) player.y = ny;
  }

  function shoot() {
    if (state !== 'playing' || shootCooldown > 0) return;
    shootCooldown = 0.28;
    shootFlash = 0.09;
    beep(190, 0.09, 'square', 0.08);
    var center = castRay(player.angle);
    var bestEnemy = null, bestDist = 999;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      var dx = e.x - player.x, dy = e.y - player.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var rel = normAngle(Math.atan2(dy, dx) - player.angle);
      if (Math.abs(rel) < 0.1 && dist < center.dist && dist < bestDist) {
        bestEnemy = e; bestDist = dist;
      }
    }
    if (bestEnemy) {
      bestEnemy.hp -= 34;
      hitMarker = 0.18;
      beep(320, 0.07, 'sine', 0.07);
      if (bestEnemy.hp <= 0) {
        enemies.splice(enemies.indexOf(bestEnemy), 1);
        score += 100; kills += 1;
        beep(520, 0.1, 'sine', 0.08);
        setTimeout(function () { beep(780, 0.12, 'sine', 0.07); }, 70);
        updateHud();
        if (kills >= WIN_KILLS) { endGame(true); return; }
      }
    }
    updateHud();
  }

  function update(dt) {
    // Look.
    if (keys.ArrowLeft) player.angle -= 2.8 * dt;
    if (keys.ArrowRight) player.angle += 2.8 * dt;
    // Move (WASD, relative to facing).
    var fwd = 0, strafe = 0;
    if (keys.w || keys.ArrowUp) fwd += 1;
    if (keys.s || keys.ArrowDown) fwd -= 1;
    if (keys.a) strafe -= 1;
    if (keys.d) strafe += 1;
    if (touchMove.active) { fwd += -touchMove.dy; strafe += touchMove.dx; }
    if (fwd || strafe) {
      var len = Math.sqrt(fwd * fwd + strafe * strafe);
      fwd /= len; strafe /= len;
      var ca = Math.cos(player.angle), sa = Math.sin(player.angle);
      var vx = (ca * fwd - sa * strafe) * player.speed * dt;
      var vy = (sa * fwd + ca * strafe) * player.speed * dt;
      tryMove(player.x + vx, player.y + vy);
      bob += dt * 9;
    }
    if (shootCooldown > 0) shootCooldown -= dt;
    if (shootFlash > 0) shootFlash -= dt;
    if (hitMarker > 0) hitMarker -= dt;
    if (hurtFlash > 0) hurtFlash -= dt;

    // Spawning.
    if (toSpawn > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnEnemy(); toSpawn -= 1; spawnTimer = 0.8; updateHud(); }
    } else if (enemies.length === 0) {
      if (wave >= 5) { endGame(true); return; }
      betweenWaves += dt;
      if (betweenWaves > 0.1 && betweenWaves < 0.2) beep(660, 0.15, 'sine', 0.07);
      if (betweenWaves >= 3) { betweenWaves = 0; startWave(wave + 1); }
    }

    // Enemies chase and attack.
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i];
      var dx = player.x - e.x, dy = player.y - e.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      e.wobble += dt * 3;
      if (dist > 1.05) {
        var step = e.speed * dt;
        var nx = e.x + (dx / dist) * step + Math.cos(e.wobble) * 0.15 * dt;
        var ny = e.y + (dy / dist) * step + Math.sin(e.wobble) * 0.15 * dt;
        if (!isWall(nx, e.y)) e.x = nx;
        if (!isWall(e.x, ny)) e.y = ny;
      }
      if (e.attack > 0) e.attack -= dt;
      if (dist < 1.15 && e.attack <= 0) {
        e.attack = 1.0;
        hp -= 9;
        hurtFlash = 0.35;
        beep(120, 0.2, 'sawtooth', 0.09);
        updateHud();
        if (hp <= 0) { hp = 0; updateHud(); endGame(false); return; }
      }
    }
    // Keep enemies from stacking exactly.
    for (var a = 0; a < enemies.length; a++) {
      for (var b = a + 1; b < enemies.length; b++) {
        var ex = enemies[b].x - enemies[a].x, ey = enemies[b].y - enemies[a].y;
        var ed = Math.sqrt(ex * ex + ey * ey);
        if (ed > 0.01 && ed < 0.6) {
          var push = (0.6 - ed) / 2;
          enemies[a].x -= (ex / ed) * push; enemies[a].y -= (ey / ed) * push;
          enemies[b].x += (ex / ed) * push; enemies[b].y += (ey / ed) * push;
        }
      }
    }
  }

  function draw() {
    // Ceiling + floor.
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0b0b2a');
    grad.addColorStop(0.5, '#14143a');
    grad.addColorStop(0.5, '#1a1a2e');
    grad.addColorStop(1, '#0a0a18');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    if (state === 'title') {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff5d8f';
      ctx.font = 'bold 46px system-ui, sans-serif';
      ctx.fillText('VOID STRIKE', W / 2, 120);
      ctx.fillStyle = '#eef2ff';
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillText('Clear 5 waves of drones. 25 kills to win.', W / 2, 165);
      ctx.fillText('Drones hurt you up close. Keep moving.', W / 2, 195);
      ctx.fillStyle = '#b9c4ff';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText('WASD move  •  drag mouse to look  •  click / Space to shoot', W / 2, 240);
      ctx.fillText('Touch: left drag moves, right drag looks, FIRE shoots', W / 2, 265);
      ctx.fillStyle = '#ff5d8f';
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillText(best > 0 ? 'Best score: ' + best : 'Tap Play or press Enter', W / 2, 310);
      return;
    }

    var colW = W / RAYS;
    var zbuffer = [];
    for (var c = 0; c < RAYS; c++) {
      var rayAngle = player.angle - FOV / 2 + (c / RAYS) * FOV;
      var hit = castRay(rayAngle);
      var dist = hit.dist * Math.cos(rayAngle - player.angle); // fix fisheye
      zbuffer.push(dist);
      var wallH = Math.min(H * 2, (H * 0.9) / Math.max(0.05, dist));
      var shade = Math.max(0.25, 1 - dist / 12);
      var r = Math.floor(120 * shade), g = Math.floor(60 * shade), b = Math.floor(190 * shade);
      if (hit.side === 1) { r = Math.floor(r * 0.7); g = Math.floor(g * 0.7); b = Math.floor(b * 0.7); }
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(c * colW, (H - wallH) / 2 + Math.sin(bob) * 2, colW + 1, wallH);
    }

    // Enemies, far to near.
    var sorted = enemies.slice().sort(function (a, b) {
      var da = (a.x - player.x) * (a.x - player.x) + (a.y - player.y) * (a.y - player.y);
      var db = (b.x - player.x) * (b.x - player.x) + (b.y - player.y) * (b.y - player.y);
      return db - da;
    });
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      var dx = e.x - player.x, dy = e.y - player.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var rel = normAngle(Math.atan2(dy, dx) - player.angle);
      if (Math.abs(rel) > FOV / 2 + 0.15) continue;
      var wallAt = castRay(player.angle + rel).dist;
      if (dist > wallAt) continue;
      var screenX = (0.5 + rel / FOV) * W;
      var size = (H * 0.75) / Math.max(0.3, dist);
      var top = H / 2 - size / 2 + Math.sin(bob) * 2;
      // Body.
      ctx.fillStyle = '#ff2d55';
      ctx.strokeStyle = '#ff8fa3';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, top + size * 0.45, size * 0.32, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // Eye.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(screenX, top + size * 0.38, size * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111111';
      ctx.beginPath();
      ctx.arc(screenX, top + size * 0.38, size * 0.045, 0, Math.PI * 2);
      ctx.fill();
      // HP bar.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(screenX - size * 0.3, top - 10, size * 0.6, 5);
      ctx.fillStyle = '#37e08b';
      ctx.fillRect(screenX - size * 0.3, top - 10, size * 0.6 * (e.hp / 100), 5);
    }

    // Gun.
    var gunY = H - 62 + Math.sin(bob) * 3;
    ctx.fillStyle = '#222233';
    ctx.fillRect(W / 2 - 14, gunY, 28, 62);
    ctx.fillStyle = '#444466';
    ctx.fillRect(W / 2 - 5, gunY - 22, 10, 26);
    if (shootFlash > 0) {
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(W / 2, gunY - 26, 16 + Math.random() * 10, 0, Math.PI * 2);
      ctx.fill();
    }

    // Crosshair.
    ctx.strokeStyle = hitMarker > 0 ? '#37e08b' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 10, H / 2); ctx.lineTo(W / 2 + 10, H / 2);
    ctx.moveTo(W / 2, H / 2 - 10); ctx.lineTo(W / 2, H / 2 + 10);
    ctx.stroke();

    // Wave banner.
    if (betweenWaves > 0 && state === 'playing') {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.fillText(wave >= 5 ? 'Final wave cleared!' : 'Wave ' + wave + ' cleared! Next wave in ' + Math.ceil(3 - betweenWaves) + '…', W / 2, 90);
    }
    if (hurtFlash > 0) {
      ctx.fillStyle = 'rgba(255,40,60,' + (hurtFlash * 0.7) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    if (state === 'paused' || state === 'won' || state === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      if (state === 'paused') {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px system-ui, sans-serif';
        ctx.fillText('PAUSED', W / 2, 180);
        ctx.fillStyle = '#b9c4ff';
        ctx.font = '17px system-ui, sans-serif';
        ctx.fillText('Press P to keep fighting', W / 2, 220);
      } else if (state === 'won') {
        ctx.fillStyle = '#ffd166';
        ctx.font = 'bold 42px system-ui, sans-serif';
        ctx.fillText('YOU WIN!', W / 2, 170);
        ctx.fillStyle = '#ffffff';
        ctx.font = '19px system-ui, sans-serif';
        ctx.fillText('All 5 waves cleared. 25 drones down.', W / 2, 210);
        ctx.fillStyle = '#b9c4ff';
        ctx.font = '17px system-ui, sans-serif';
        ctx.fillText('Score: ' + score + '   •   Best: ' + best, W / 2, 245);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Press Enter or tap Play to go again', W / 2, 280);
      } else {
        ctx.fillStyle = '#ff6b6b';
        ctx.font = 'bold 42px system-ui, sans-serif';
        ctx.fillText('GAME OVER', W / 2, 170);
        ctx.fillStyle = '#ffffff';
        ctx.font = '19px system-ui, sans-serif';
        ctx.fillText('The drones got you on wave ' + wave + '.', W / 2, 210);
        ctx.fillStyle = '#b9c4ff';
        ctx.font = '17px system-ui, sans-serif';
        ctx.fillText('Score: ' + score + '   •   Kills: ' + kills + '   •   Best: ' + best, W / 2, 245);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Press Enter or tap Play to try again', W / 2, 280);
      }
    }
  }

  var last = 0;
  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    if (state === 'playing') update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // Touch move joystick state.
  var touchMove = { active: false, id: null, dx: 0, dy: 0 };
  var touchLook = { active: false, id: null, lastX: 0 };

  function canvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width };
  }

  // Mouse look (drag) + click to shoot.
  var mouseDown = false, mouseMoved = 0, lastMouseX = 0;
  canvas.addEventListener('mousedown', function (e) {
    if (state === 'title' || state === 'won' || state === 'over') { startGame(); return; }
    mouseDown = true; mouseMoved = 0; lastMouseX = e.clientX;
    try { canvas.requestPointerLock(); } catch (err) {}
  });
  window.addEventListener('mousemove', function (e) {
    if (document.pointerLockElement === canvas && state === 'playing') {
      player.angle += (e.movementX || 0) * 0.0028;
      return;
    }
    if (!mouseDown) return;
    var dx = e.clientX - lastMouseX;
    lastMouseX = e.clientX;
    mouseMoved += Math.abs(dx);
    if (state === 'playing') player.angle += dx * 0.005;
  });
  window.addEventListener('mouseup', function () {
    if (mouseDown && mouseMoved < 6 && state === 'playing') shoot();
    mouseDown = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  });

  // Touch: left half = move, right half = look.
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (state === 'title' || state === 'won' || state === 'over') { startGame(); return; }
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var p = canvasPos(t);
      if (p.x < p.w / 2 && !touchMove.active) {
        touchMove.active = true; touchMove.id = t.identifier; touchMove.dx = 0; touchMove.dy = 0;
        touchMove.startX = p.x; touchMove.startY = p.y;
      } else if (!touchLook.active) {
        touchLook.active = true; touchLook.id = t.identifier; touchLook.lastX = p.x;
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var p = canvasPos(t);
      if (touchMove.active && t.identifier === touchMove.id) {
        touchMove.dx = Math.max(-1, Math.min(1, (p.x - touchMove.startX) / 50));
        touchMove.dy = Math.max(-1, Math.min(1, (p.y - touchMove.startY) / 50));
      } else if (touchLook.active && t.identifier === touchLook.id) {
        player.angle += (p.x - touchLook.lastX) * 0.008;
        touchLook.lastX = p.x;
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (touchMove.active && t.identifier === touchMove.id) { touchMove.active = false; touchMove.dx = 0; touchMove.dy = 0; }
      if (touchLook.active && t.identifier === touchLook.id) touchLook.active = false;
    }
  });

  window.addEventListener('keydown', function (e) {
    keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = true;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (state === 'title' || state === 'won' || state === 'over') startGame();
      else if (e.key === ' ') shoot();
    }
    if ((e.key === 'p' || e.key === 'P') && (state === 'playing' || state === 'paused')) {
      state = state === 'playing' ? 'paused' : 'playing';
    }
    if (e.key === 'm' || e.key === 'M') muted = !muted;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false;
  });

  startBtn.addEventListener('click', function () { startGame(); });
  fireBtn.addEventListener('click', function (e) { e.preventDefault(); shoot(); });

  updateHud();
  requestAnimationFrame(loop);
})();
