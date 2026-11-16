// Void Strike — REAL 3D FPS on Three.js r149. Plain JS, no build step.
// Procedural canvas textures, no copied assets. WebAudio bleeps only.
// WASD/arrows move, mouse drag / pointer lock to look, click/Space to shoot.
// Touch: left drag moves, right drag looks, FIRE shoots.
(function () {
  'use strict';

  var canvas = document.getElementById('game');
  var scoreEl = document.getElementById('hud-score');
  var waveEl = document.getElementById('hud-wave');
  var hpEl = document.getElementById('hud-hp');
  var bestEl = document.getElementById('hud-best');
  var enemiesEl = document.getElementById('hud-enemies');
  var hpFill = document.getElementById('hp-fill');
  var startBtn = document.getElementById('start-btn');
  var fireBtn = document.getElementById('fire-btn');
  var overlay = document.getElementById('overlay');
  var killToast = document.getElementById('kill-toast');
  var loadError = document.getElementById('load-error');
  var minimap = document.getElementById('minimap');

  var WIN_KILLS = 25;
  var WAVE_COUNTS = [4, 5, 5, 5, 6];
  var EYE = 1.6;

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
    { x: 14.5, y: 14.5 }, { x: 1.5, y: 14.5 }, { x: 14.5, y: 1.5 },
    { x: 8.5, y: 1.5 }, { x: 1.5, y: 8.5 }, { x: 14.5, y: 8.5 }
  ];

  // ---------- Settings (localStorage) ----------
  var settings = { sens: 1, speed: 1, fov: 60, muted: false };
  try {
    var saved = JSON.parse(localStorage.getItem('void-strike-settings') || '{}');
    if (saved) for (var sk in saved) if (sk in settings) settings[sk] = saved[sk];
  } catch (e) {}
  var muted = !!settings.muted;
  function saveSettings() {
    try { localStorage.setItem('void-strike-settings', JSON.stringify(settings)); } catch (e) {}
  }

  var state = 'title'; // title | playing | paused | won | over
  var score = 0;
  var kills = 0;
  var hp = 100;
  var wave = 1;
  var best = 0;
  try { best = parseInt(localStorage.getItem('void-strike-best') || '0', 10) || 0; } catch (e) { best = 0; }
  var enemies = [];
  var toSpawn = 0;
  var spawnTimer = 0;
  var betweenWaves = 0;
  var waveChime = false;
  var shootCooldown = 0;
  var shootFlash = 0;
  var gunKick = 0;
  var tracerT = 0;
  var hitMarker = 0;
  var killFlash = 0;
  var hurtFlash = 0;
  var bob = 0;
  var toastT = 0;

  var player = { x: 1.5, y: 1.5, angle: 0, pitch: 0, speed: 3.4 };
  var keys = {};

  // ---------- Three.js handles (filled in init) ----------
  var renderer = null, scene = null, camera = null, raycaster = null;
  var gun = null, muzzle = null, muzzleLight = null, tracer = null;
  var droneGroups = [];
  var particles = [];
  var isMobile = false;

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

  // DDA raycast on the grid (wall distance for occlusion + tracer).
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

  // BFS on the grid, 4-connected. Returns [{x, y}, ...] cell centers from the
  // cell after the start to the target, or null if unreachable.
  function findPath(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    var MW = MAP[0].length, MH = MAP.length;
    var prev = {};
    prev[sx + ',' + sy] = null;
    var q = [[sx, sy]];
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
      var c = q.shift();
      for (var i = 0; i < 4; i++) {
        var nx = c[0] + dirs[i][0], ny = c[1] + dirs[i][1];
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
        if (MAP[ny].charAt(nx) === '1') continue;
        var k = nx + ',' + ny;
        if (k in prev) continue;
        prev[k] = c;
        if (nx === tx && ny === ty) {
          var path = [];
          var cur = [nx, ny];
          while (cur) { path.unshift({ x: cur[0] + 0.5, y: cur[1] + 0.5 }); cur = prev[cur[0] + ',' + cur[1]]; }
          path.shift(); // drop the start cell
          return path;
        }
        q.push([nx, ny]);
      }
    }
    return null;
  }

  // ---------- Procedural textures (drawn in code, no assets) ----------
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function wallTexture() {
    var c = makeCanvas(256, 256), g = c.getContext('2d');
    g.fillStyle = '#232338'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#2c2c48';
    g.fillRect(8, 8, 240, 112); g.fillRect(8, 136, 240, 112);
    g.fillStyle = '#1a1a2e';
    g.fillRect(8, 120, 240, 8); g.fillRect(8, 248, 240, 8);
    // Neon edge strips.
    g.fillStyle = '#ff5d8f'; g.fillRect(8, 8, 240, 4);
    g.fillStyle = '#22d3ee'; g.fillRect(8, 248, 240, 4);
    // Panel seams + rivets.
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3;
    g.strokeRect(8, 8, 240, 112); g.strokeRect(8, 136, 240, 112);
    g.beginPath(); g.moveTo(128, 8); g.lineTo(128, 120); g.moveTo(128, 136); g.lineTo(128, 248); g.stroke();
    g.fillStyle = '#4a4a6e';
    var pts = [[20, 20], [236, 20], [20, 108], [236, 108], [20, 148], [236, 148], [20, 236], [236, 236]];
    for (var i = 0; i < pts.length; i++) { g.beginPath(); g.arc(pts[i][0], pts[i][1], 5, 0, Math.PI * 2); g.fill(); }
    // Hazard chevrons near the base.
    g.fillStyle = '#ffd166';
    for (var x = 16; x < 240; x += 32) {
      g.beginPath(); g.moveTo(x, 244); g.lineTo(x + 12, 228); g.lineTo(x + 24, 244); g.closePath(); g.fill();
    }
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  function floorTexture() {
    var c = makeCanvas(256, 256), g = c.getContext('2d');
    g.fillStyle = '#101018'; g.fillRect(0, 0, 256, 256);
    for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 2 ? '#141422' : '#0d0d16';
      g.fillRect(x * 64, y * 64, 64, 64);
    }
    g.strokeStyle = 'rgba(80,120,255,0.35)'; g.lineWidth = 2;
    for (var i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke();
    }
    g.fillStyle = 'rgba(255,93,143,0.5)';
    g.beginPath(); g.arc(32, 32, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(34,211,238,0.5)';
    g.beginPath(); g.arc(224, 224, 4, 0, Math.PI * 2); g.fill();
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8, 8);
    return t;
  }
  function skyTexture() {
    var c = makeCanvas(16, 256), g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#02020a');
    grad.addColorStop(0.45, '#0b0b2a');
    grad.addColorStop(0.62, '#2a1145');
    grad.addColorStop(0.75, '#0d0d20');
    grad.addColorStop(1, '#050510');
    g.fillStyle = grad; g.fillRect(0, 0, 16, 256);
    return new THREE.CanvasTexture(c);
  }

  // ---------- 3D scene ----------
  function buildWorld() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050510);
    scene.fog = new THREE.FogExp2(0x070722, 0.045);

    camera = new THREE.PerspectiveCamera(settings.fov, 1280 / 800, 0.1, 140);
    camera.rotation.order = 'YXZ';
    camera.position.set(player.x, EYE, player.y);
    scene.add(camera);

    // Lighting: hemisphere + ambient + shadow-casting directional sun.
    scene.add(new THREE.HemisphereLight(0x8fb8ff, 0x1a1030, 0.55));
    scene.add(new THREE.AmbientLight(0x334466, 0.5));
    var sun = new THREE.DirectionalLight(0xfff2dd, 1.15);
    sun.position.set(10, 18, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
    sun.shadow.camera.left = -11; sun.shadow.camera.right = 11;
    sun.shadow.camera.top = 11; sun.shadow.camera.bottom = -11;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 45;
    sun.shadow.bias = -0.0005;
    sun.target.position.set(8, 0, 8);
    scene.add(sun);
    scene.add(sun.target);
    // Mood lights in the arena (no shadows — cheap colour).
    var pink = new THREE.PointLight(0xff5d8f, 0.7, 12, 2); pink.position.set(4, 2.2, 4); scene.add(pink);
    var cyan = new THREE.PointLight(0x22d3ee, 0.7, 12, 2); cyan.position.set(12, 2.2, 12); scene.add(cyan);

    // Sky dome + stars.
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false })
    );
    sky.position.set(8, 0, 8);
    scene.add(sky);
    var starGeo = new THREE.BufferGeometry();
    var starPos = [];
    for (var s = 0; s < 400; s++) {
      var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.45;
      var r = 52;
      starPos.push(8 + r * Math.sin(ph) * Math.cos(th), 4 + r * Math.cos(ph) * 0.6, 8 + r * Math.sin(ph) * Math.sin(th));
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true, fog: false })));

    // Floor.
    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85, metalness: 0.25 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(8, 0, 8);
    floor.receiveShadow = true;
    scene.add(floor);

    // Walls — one box per wall cell, shared geometry/material.
    var wallGeo = new THREE.BoxGeometry(1, 2.6, 1);
    var wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.6, metalness: 0.45 });
    for (var my = 0; my < MAP.length; my++) {
      for (var mx = 0; mx < MAP[0].length; mx++) {
        if (MAP[my].charAt(mx) !== '1') continue;
        var w = new THREE.Mesh(wallGeo, wallMat);
        w.position.set(mx + 0.5, 1.3, my + 0.5);
        w.castShadow = true;
        w.receiveShadow = true;
        scene.add(w);
      }
    }

    buildGun();
    buildParticles();
    raycaster = new THREE.Raycaster();
    raycaster.far = 30;
  }

  function buildGun() {
    gun = new THREE.Group();
    var dark = new THREE.MeshStandardMaterial({ color: 0x1c1c2e, roughness: 0.4, metalness: 0.8 });
    var mid = new THREE.MeshStandardMaterial({ color: 0x3a3a58, roughness: 0.35, metalness: 0.85 });
    var glow = new THREE.MeshStandardMaterial({ color: 0x111122, emissive: 0x22d3ee, emissiveIntensity: 1.4, roughness: 0.4 });
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.44), dark);
    gun.add(body);
    var barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.34, 12), mid);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.34);
    gun.add(barrel);
    var sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.08), glow);
    sight.position.set(0, 0.1, -0.08);
    gun.add(sight);
    var strip = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.02, 0.3), glow);
    strip.position.set(0, -0.02, -0.05);
    gun.add(strip);
    var grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.18, 0.1), mid);
    grip.position.set(0, -0.14, 0.14);
    grip.rotation.x = 0.3;
    gun.add(grip);
    // Muzzle flash cone (hidden until firing).
    muzzle = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.3, 10),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    muzzle.rotation.x = -Math.PI / 2;
    muzzle.position.set(0, 0.02, -0.62);
    gun.add(muzzle);
    muzzleLight = new THREE.PointLight(0xffc266, 0, 7, 2);
    muzzleLight.position.set(0, 0, -0.9);
    gun.add(muzzleLight);
    gun.position.set(0.34, -0.34, -0.62);
    camera.add(gun);
    // Tracer beam.
    tracer = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.025, 1),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    tracer.visible = false;
    scene.add(tracer);
  }

  function buildParticles() {
    var geo = new THREE.SphereGeometry(0.05, 6, 6);
    for (var i = 0; i < 48; i++) {
      var m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd166 }));
      m.visible = false;
      scene.add(m);
      particles.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, t: 0 });
    }
  }
  function burst(x, y, z, color, n) {
    var made = 0;
    for (var i = 0; i < particles.length && made < n; i++) {
      var p = particles[i];
      if (p.life > 0) continue;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, z);
      p.mesh.material.color.setHex(color);
      var a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI - Math.PI / 2;
      var sp = 2 + Math.random() * 4;
      p.vx = Math.cos(a) * Math.cos(b) * sp;
      p.vy = Math.sin(b) * sp + 1.5;
      p.vz = Math.sin(a) * Math.cos(b) * sp;
      p.life = 0.5 + Math.random() * 0.4;
      p.t = 0;
      made++;
    }
  }
  function updateParticles(dt) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.life <= 0) continue;
      p.t += dt;
      if (p.t >= p.life) { p.life = 0; p.mesh.visible = false; continue; }
      p.vy -= 6 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      var s = 1 - p.t / p.life;
      p.mesh.scale.set(s, s, s);
    }
  }

  // ---------- Drones (3D models built from geometry) ----------
  function makeDroneMesh(e) {
    var g = new THREE.Group();
    g.userData.enemy = e;
    var bodyMat = new THREE.MeshStandardMaterial({ color: 0xff2d55, roughness: 0.3, metalness: 0.7, emissive: 0x660011, emissiveIntensity: 0.9 });
    e.bodyMat = bodyMat;
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), bodyMat);
    body.castShadow = true;
    g.add(body);
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.48, 0.045, 10, 28),
      new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.4, metalness: 0.8, emissive: 0xff5d8f, emissiveIntensity: 1.1 })
    );
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    var eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    eye.position.set(0, 0.08, 0.3);
    g.add(eye);
    var pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x111111 }));
    pupil.position.set(0, 0.08, 0.41);
    g.add(pupil);
    var antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.32, 6),
      new THREE.MeshStandardMaterial({ color: 0x8888aa, roughness: 0.4, metalness: 0.9 }));
    antenna.position.set(0, 0.48, 0);
    g.add(antenna);
    var tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    tip.position.set(0, 0.65, 0);
    g.add(tip);
    // HP bar (faces the player because the group lookAts the camera).
    var bg = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.08, 0.01),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.7 }));
    bg.position.set(0, 0.66, 0);
    g.add(bg);
    var fg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.012),
      new THREE.MeshBasicMaterial({ color: 0x37e08b }));
    fg.position.set(0, 0.66, 0.012);
    g.add(fg);
    e.hpBar = fg;
    return g;
  }

  function spawnEnemy() {
    var s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
    var dx = s.x - player.x, dy = s.y - player.y;
    if (dx * dx + dy * dy < 9) s = SPAWNS[(Math.floor(Math.random() * SPAWNS.length) + 3) % SPAWNS.length];
    var e = {
      x: s.x + (Math.random() - 0.5) * 0.4,
      y: s.y + (Math.random() - 0.5) * 0.4,
      hp: 100,
      speed: 1.05 + wave * 0.14 + Math.random() * 0.25,
      attack: 0,
      path: null,
      pathT: 0,
      wp: 0,
      wobble: Math.random() * Math.PI * 2,
      flash: 0,
      mesh: null,
      bodyMat: null,
      hpBar: null
    };
    e.mesh = makeDroneMesh(e);
    e.mesh.position.set(e.x, 1.05, e.y);
    scene.add(e.mesh);
    droneGroups.push(e.mesh);
    enemies.push(e);
  }
  function removeEnemy(e) {
    scene.remove(e.mesh);
    droneGroups.splice(droneGroups.indexOf(e.mesh), 1);
    enemies.splice(enemies.indexOf(e), 1);
  }

  function startWave(n) {
    wave = n;
    waveChime = false;
    toSpawn = WAVE_COUNTS[n - 1];
    spawnTimer = 0.5;
    updateHud();
  }

  function reset() {
    for (var i = enemies.length - 1; i >= 0; i--) removeEnemy(enemies[i]);
    score = 0; kills = 0; hp = 100;
    toSpawn = 0; betweenWaves = 0;
    shootCooldown = 0; shootFlash = 0; gunKick = 0; tracerT = 0;
    hitMarker = 0; killFlash = 0; hurtFlash = 0;
    player.x = 1.5; player.y = 1.5; player.angle = 0; player.pitch = 0;
    startWave(1);
  }

  function startGame() {
    reset();
    state = 'playing';
    startBtn.textContent = 'Restart';
    hideOverlay();
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
    showOverlay();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = 'Score: ' + score;
    waveEl.textContent = 'Wave: ' + wave + '/5';
    if (bestEl) bestEl.textContent = 'Best: ' + best;
    hpEl.textContent = 'HP: ' + Math.max(0, Math.ceil(hp));
    enemiesEl.textContent = 'Drones: ' + (enemies.length + toSpawn);
    if (hpFill) {
      hpFill.style.width = Math.max(0, hp) + '%';
      hpFill.style.background = hp > 50 ? '#37e08b' : hp > 25 ? '#ffd166' : '#ff5d5d';
    }
  }

  function tryMove(nx, ny) {
    if (!isWall(nx, player.y)) player.x = nx;
    if (!isWall(player.x, ny)) player.y = ny;
  }

  function findEnemyRoot(obj) {
    while (obj) {
      if (obj.userData && obj.userData.enemy) return obj.userData.enemy;
      obj = obj.parent;
    }
    return null;
  }

  function shoot() {
    if (state !== 'playing' || shootCooldown > 0 || !raycaster) return;
    shootCooldown = 0.28;
    shootFlash = 0.09;
    gunKick = 1;
    beep(190, 0.09, 'square', 0.08);
    if (muzzle) muzzle.material.opacity = 0.95;
    if (muzzleLight) muzzleLight.intensity = 3.2;
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    var hits = raycaster.intersectObjects(droneGroups, true);
    var wallDist = castRay(player.angle).dist;
    var hitPoint = null;
    var bestEnemy = null, bestDist = 999;
    for (var i = 0; i < hits.length; i++) {
      var e = findEnemyRoot(hits[i].object);
      if (!e) continue;
      if (hits[i].distance < bestDist) { bestEnemy = e; bestDist = hits[i].distance; hitPoint = hits[i].point; }
    }
    if (bestEnemy && bestDist < wallDist) {
      bestEnemy.hp -= 34;
      bestEnemy.flash = 0.12;
      hitMarker = 0.22;
      beep(320, 0.07, 'sine', 0.07);
      burst(bestEnemy.x, 1.1, bestEnemy.y, 0xffd166, 10);
      if (bestEnemy.hp <= 0) {
        burst(bestEnemy.x, 1.1, bestEnemy.y, 0xff2d55, 18);
        removeEnemy(bestEnemy);
        score += 100; kills += 1;
        killFlash = 0.3;
        showToast('KILL +100');
        beep(520, 0.1, 'sine', 0.08);
        setTimeout(function () { beep(780, 0.12, 'sine', 0.07); }, 70);
        updateHud();
        if (kills >= WIN_KILLS) { endGame(true); return; }
      } else if (bestEnemy.hpBar) {
        bestEnemy.hpBar.scale.x = Math.max(0, bestEnemy.hp / 100);
      }
    } else {
      // Miss: tracer ends at the wall.
      var d = Math.cos(player.angle), dz = Math.sin(player.angle);
      hitPoint = new THREE.Vector3(player.x + d * wallDist, EYE - 0.15, player.y + dz * wallDist);
    }
    if (hitPoint && tracer) {
      var start = camera.localToWorld(new THREE.Vector3(0.34, -0.28, -1.1));
      var mid = new THREE.Vector3((start.x + hitPoint.x) / 2, (start.y + hitPoint.y) / 2, (start.z + hitPoint.z) / 2);
      tracer.position.copy(mid);
      tracer.lookAt(hitPoint);
      var len = Math.sqrt(Math.pow(hitPoint.x - start.x, 2) + Math.pow(hitPoint.y - start.y, 2) + Math.pow(hitPoint.z - start.z, 2));
      tracer.scale.set(1, 1, Math.max(0.1, len));
      tracer.visible = true;
      tracerT = 0.07;
    }
    updateHud();
  }

  function showToast(text) {
    if (!killToast) return;
    killToast.textContent = text;
    killToast.style.opacity = '1';
    toastT = 0.7;
  }

  function update(dt) {
    // Look — arrow keys turn, scaled by sensitivity.
    var turnRate = 2.0 + 0.8 * settings.sens;
    if (keys.ArrowLeft) player.angle -= turnRate * dt;
    if (keys.ArrowRight) player.angle += turnRate * dt;
    // Move: WASD + arrows (Up/Down forward/back, A/D strafe).
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
    if (gunKick > 0) gunKick = Math.max(0, gunKick - dt * 6);
    if (tracerT > 0) { tracerT -= dt; if (tracerT <= 0 && tracer) tracer.visible = false; }
    if (hitMarker > 0) hitMarker -= dt;
    if (killFlash > 0) killFlash -= dt;
    if (hurtFlash > 0) hurtFlash -= dt;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0 && killToast) killToast.style.opacity = '0'; }
    if (muzzle) muzzle.material.opacity = shootFlash > 0 ? 0.95 : 0;
    if (muzzleLight) muzzleLight.intensity = shootFlash > 0 ? 3.2 : 0;
    if (gun) { gun.position.z = -0.62 + gunKick * 0.09; gun.rotation.x = gunKick * 0.18; }

    // Spawning.
    if (toSpawn > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnEnemy(); toSpawn -= 1; spawnTimer = 0.8; updateHud(); }
    } else if (enemies.length === 0) {
      if (wave >= 5) { endGame(true); return; }
      betweenWaves += dt;
      if (betweenWaves > 0.1 && !waveChime) { waveChime = true; beep(660, 0.15, 'sine', 0.07); }
      if (betweenWaves >= 3) { betweenWaves = 0; startWave(wave + 1); }
    }

    // Enemies chase (BFS) and attack.
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i];
      var dx = player.x - e.x, dy = player.y - e.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      e.wobble += dt * 3;
      if (e.flash > 0) e.flash -= dt;
      if (e.bodyMat) e.bodyMat.emissive.setHex(e.flash > 0 ? 0xffffff : 0x660011);
      if (dist > 1.05) {
        e.pathT -= dt;
        if (!e.path || e.pathT <= 0 || e.wp >= e.path.length) {
          e.path = findPath(Math.floor(e.x), Math.floor(e.y), Math.floor(player.x), Math.floor(player.y));
          e.wp = 0;
          e.pathT = 0.5;
        }
        var tx, ty;
        if (e.path && e.path.length) {
          var node = e.path[Math.min(e.wp, e.path.length - 1)];
          tx = node.x; ty = node.y;
          if (Math.abs(e.x - tx) < 0.15 && Math.abs(e.y - ty) < 0.15) e.wp++;
        } else {
          tx = player.x; ty = player.y;
        }
        var pdx = tx - e.x, pdy = ty - e.y;
        var pd = Math.sqrt(pdx * pdx + pdy * pdy) || 0.001;
        var step = e.speed * dt;
        var nx = e.x + (pdx / pd) * step;
        var ny = e.y + (pdy / pd) * step;
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

  function syncCamera() {
    camera.position.set(player.x, EYE + Math.sin(bob) * 0.05, player.y);
    camera.rotation.y = -player.angle - Math.PI / 2;
    camera.rotation.x = player.pitch;
  }

  function drawMinimap() {
    if (!minimap) return;
    var g = minimap.getContext('2d');
    if (!g) return;
    var S = minimap.width, cell = S / 16;
    g.fillStyle = 'rgba(5,5,20,0.9)';
    g.fillRect(0, 0, S, S);
    for (var my = 0; my < 16; my++) {
      for (var mx = 0; mx < 16; mx++) {
        if (MAP[my].charAt(mx) === '1') {
          g.fillStyle = '#3a3a6e';
          g.fillRect(mx * cell, my * cell, cell, cell);
        }
      }
    }
    for (var i = 0; i < enemies.length; i++) {
      g.fillStyle = '#ff2d55';
      g.beginPath();
      g.arc(enemies[i].x * cell, enemies[i].y * cell, 4, 0, Math.PI * 2);
      g.fill();
    }
    // Player arrow.
    g.save();
    g.translate(player.x * cell, player.y * cell);
    g.rotate(Math.atan2(Math.sin(player.angle), Math.cos(player.angle)) + Math.PI / 2);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -6); g.lineTo(4.5, 5); g.lineTo(-4.5, 5);
    g.closePath();
    g.fill();
    g.restore();
  }

  function render() {
    if (!renderer) return;
    // Drone meshes follow their logic positions, facing the player.
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      e.mesh.position.set(e.x, 1.05 + Math.sin(e.wobble) * 0.08, e.y);
      e.mesh.lookAt(camera.position.x, 1.05, camera.position.z);
    }
    syncCamera();
    renderer.render(scene, camera);
    drawMinimap();
    // Hurt vignette: cheap 2D flash drawn by dimming via overlay opacity is
    // handled in CSS-free way — skip; the HP bar + red toast cover feedback.
  }

  var last = 0;
  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    if (state === 'playing') update(dt);
    else if (state === 'title') { player.angle += dt * 0.12; }
    updateParticles(dt);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Overlay screens ----------
  function showOverlay() {
    if (!overlay) return;
    var html = '';
    if (state === 'title') {
      html = '<h2>VOID STRIKE</h2>' +
        '<p>Real 3D. Clear 5 waves of drones — 25 kills to win.</p>' +
        '<p class="sub">Drones hunt you through the maze and hurt you up close. Keep moving, watch the minimap.</p>' +
        '<p class="sub">WASD / Arrows to move &amp; turn &nbsp;•&nbsp; drag mouse to look &nbsp;•&nbsp; click / Space to shoot</p>' +
        '<p class="sub">Touch: left drag moves, right drag looks, FIRE shoots</p>' +
        '<p class="sub">Tune it in Settings below — sensitivity, speed, field of view.</p>' +
        '<p>' + (best > 0 ? 'Best score: ' + best : 'Tap Play or press Enter') + '</p>' +
        '<button type="button">Play</button>';
    } else if (state === 'paused') {
      html = '<h2>PAUSED</h2><p>Press P or tap to keep fighting.</p><button type="button">Resume</button>';
    } else if (state === 'won') {
      html = '<h2 style="color:#ffd166">YOU WIN!</h2>' +
        '<p>All 5 waves cleared. 25 drones down.</p>' +
        '<p>Score: ' + score + ' &nbsp;•&nbsp; Best: ' + best + '</p>' +
        '<button type="button">Play Again</button>';
    } else if (state === 'over') {
      html = '<h2 style="color:#ff6b6b">GAME OVER</h2>' +
        '<p>The drones got you on wave ' + wave + '.</p>' +
        '<p>Score: ' + score + ' &nbsp;•&nbsp; Kills: ' + kills + ' &nbsp;•&nbsp; Best: ' + best + '</p>' +
        '<button type="button">Try Again</button>';
    }
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
  }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }
  if (overlay) overlay.addEventListener('click', function () {
    if (state === 'title' || state === 'won' || state === 'over') startGame();
    else if (state === 'paused') { state = 'playing'; hideOverlay(); }
  });

  // ---------- Settings panel wiring ----------
  function bindRange(id, valId, key, fmt) {
    var el = document.getElementById(id);
    var valEl = document.getElementById(valId);
    if (!el) return;
    el.value = settings[key];
    if (valEl) valEl.textContent = fmt(settings[key]);
    el.addEventListener('input', function () {
      settings[key] = parseFloat(el.value);
      if (valEl) valEl.textContent = fmt(settings[key]);
      saveSettings();
      applySettings();
    });
  }
  function applySettings() {
    player.speed = 3.4 * settings.speed;
    muted = !!settings.muted;
    var muteEl = document.getElementById('mute');
    if (muteEl) muteEl.checked = muted;
    if (camera) {
      camera.fov = settings.fov;
      camera.updateProjectionMatrix();
    }
  }
  bindRange('sens', 'sens-val', 'sens', function (v) { return v.toFixed(1) + 'x'; });
  bindRange('speed', 'speed-val', 'speed', function (v) { return v.toFixed(1) + 'x'; });
  bindRange('fov', 'fov-val', 'fov', function (v) { return v + '°'; });
  (function () {
    var muteEl = document.getElementById('mute');
    if (!muteEl) return;
    muteEl.checked = muted;
    muteEl.addEventListener('change', function () {
      settings.muted = muteEl.checked;
      saveSettings();
      applySettings();
    });
  })();

  // ---------- Input ----------
  var touchMove = { active: false, id: null, dx: 0, dy: 0, startX: 0, startY: 0 };
  var touchLook = { active: false, id: null, lastX: 0, lastY: 0 };

  function canvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width };
  }

  var mouseDown = false, mouseMoved = 0, lastMouseX = 0, lastMouseY = 0;
  canvas.addEventListener('mousedown', function (e) {
    if (state !== 'playing') return;
    mouseDown = true; mouseMoved = 0; lastMouseX = e.clientX; lastMouseY = e.clientY;
    try { canvas.requestPointerLock(); } catch (err) {}
  });
  window.addEventListener('mousemove', function (e) {
    if (document.pointerLockElement === canvas && state === 'playing') {
      player.angle += (e.movementX || 0) * 0.0028 * settings.sens;
      player.pitch -= (e.movementY || 0) * 0.0028 * settings.sens;
      player.pitch = Math.max(-0.6, Math.min(0.6, player.pitch));
      return;
    }
    if (!mouseDown) return;
    var dx = e.clientX - lastMouseX, dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX; lastMouseY = e.clientY;
    mouseMoved += Math.abs(dx) + Math.abs(dy);
    if (state === 'playing') {
      player.angle += dx * 0.005 * settings.sens;
      player.pitch -= dy * 0.005 * settings.sens;
      player.pitch = Math.max(-0.6, Math.min(0.6, player.pitch));
    }
  });
  window.addEventListener('mouseup', function () {
    if (mouseDown && mouseMoved < 6 && state === 'playing') shoot();
    mouseDown = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  });

  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (state !== 'playing') return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var p = canvasPos(t);
      if (p.x < p.w / 2 && !touchMove.active) {
        touchMove.active = true; touchMove.id = t.identifier; touchMove.dx = 0; touchMove.dy = 0;
        touchMove.startX = p.x; touchMove.startY = p.y;
      } else if (!touchLook.active) {
        touchLook.active = true; touchLook.id = t.identifier; touchLook.lastX = p.x; touchLook.lastY = p.y;
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
        player.angle += (p.x - touchLook.lastX) * 0.008 * settings.sens;
        player.pitch -= (p.y - touchLook.lastY) * 0.008 * settings.sens;
        player.pitch = Math.max(-0.6, Math.min(0.6, player.pitch));
        touchLook.lastX = p.x; touchLook.lastY = p.y;
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
      if (state === 'playing') { state = 'paused'; showOverlay(); }
      else { state = 'playing'; hideOverlay(); }
    }
    if (e.key === 'm' || e.key === 'M') {
      settings.muted = !settings.muted;
      saveSettings();
      applySettings();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false;
  });

  startBtn.addEventListener('click', function () { startGame(); });
  fireBtn.addEventListener('click', function (e) { e.preventDefault(); shoot(); });

  window.addEventListener('resize', function () {
    if (!renderer || !camera) return;
    var cw = canvas.clientWidth || canvas.width, ch = canvas.clientHeight || canvas.height;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  });

  // ---------- Boot (wait for Three.js, CDN or local fallback) ----------
  var bootTries = 0;
  function boot() {
    if (window.THREE) {
      try {
        isMobile = (window.innerWidth || 1280) < 700 ||
          (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
        var cw = canvas.clientWidth || canvas.width, ch = canvas.clientHeight || canvas.height;
        renderer.setSize(cw, ch, false);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        buildWorld();
        applySettings();
        if (loadError) loadError.hidden = true;
        updateHud();
        showOverlay();
        requestAnimationFrame(loop);
      } catch (err) {
        if (loadError) { loadError.hidden = false; loadError.textContent = '3D could not start on this device (' + (err && err.message ? err.message : 'WebGL unavailable') + '). Try another browser.'; }
      }
      return;
    }
    if (bootTries++ < 50) { setTimeout(boot, 200); return; }
    if (loadError) { loadError.hidden = false; loadError.textContent = 'The 3D engine did not load. Check your connection and reload.'; }
  }
  if (loadError) loadError.hidden = false;
  boot();
})();
