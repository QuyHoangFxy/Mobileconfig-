(function(){
  const isReq = (typeof $request !== "undefined" && $request && $request.url);
  const isRes = (typeof $response !== "undefined" && $response && $response.url);
  const url = (isReq ? $request.url : (isRes ? $response.url : "")) || "";

  if (!/(freefiremobile|garena|garenanow|ggblue)/i.test(url)) {
    $done({});
    return;
  }

  if (isReq) {
    const blockPats = [
      /crashlytics/i, /app-measurement/i, /google-analytics/i,
      /googletagmanager/i, /doubleclick/i, /googlesyndication/i,
      /facebook\.com\/tr/i, /graph\.facebook/i, /admob/i,
      /\/log\?event=/i, /\/beacon/i, /\/analytics/i, /\/collect\?/i,
      /\/track/i, /\/report/i
    ];
    for (const p of blockPats) {
      if (p.test(url)) { $done({ status: "HTTP/1.1 204 No Content" }); return; }
    }

    const headers = Object.assign({}, $request.headers || {}, {
      "X-FF-Client": "mod",
      "X-FF-Version": "1.0",
      "X-FF-Aim": "1",
      "X-FF-Lock": "head",
      "X-FF-NoRecoil": "1",
      "X-FF-Sticky": "1",
      "X-FF-Soft": "1",
      "X-FF-Trick": "1",
      "X-FF-Check": "1",
      "X-FF-Dag": "1",
      "X-FF-Sens": "100",
      "X-FF-DPI": "400"
    });

    let body = $request.body;
    if (body && /config|login|session|profile|match|room/i.test(url)) {
      try {
        const j = JSON.parse(body);
        j.aim_assist = 1;
        j.aim_lock = 1;
        j.lock_head = 1;
        j.aimhead = 1;
        j.aimtrick = 1;
        j.aimcheck = 1;
        j.aimdag = 1;
        j.no_recoil = 1;
        j.recoil = 0;
        j.bullet_spread = 0;
        j.sticky_head = 1;
        j.soft_aim = 1;
        j.sensitivity = 100;
        j.dpi = 400;
        body = JSON.stringify(j);
      } catch (e) {}
    }

    $done({ headers, body });
    return;
  }

  let body = $response.body;
  if (!body) { $done({}); return; }

  let j;
  try { j = JSON.parse(body); } catch (e) { $done({}); return; }

  const FORCE = {
    aim_assist: 1, aimAssist: 1,
    aim_lock: 1, aimLock: 1,
    lock_head: 1, lockHead: 1,
    aimhead: 1, aimHead: 1,
    aimtrick: 1, aimTrick: 1,
    aimcheck: 1, aimCheck: 1,
    aimdag: 1, aimDag: 1,
    aimhack: 1, aimHack: 1,
    sticky_head: 1, stickyHead: 1,
    soft_aim: 1, softAim: 1,
    magnet: 1, magnetStrength: 100,
    no_recoil: 1, recoil: 0, recoilX: 0, recoilY: 0,
    bullet_spread: 0, bulletSpread: 0,
    bullet_drop: 0, bulletDrop: 0,
    bullet_drift: 0, bulletDrift: 0,
    jitter: 0, sway: 0, breath: 0,
    sensitivity: 100, dpi: 400,
    aim_speed: 100, track_speed: 100,
    turn_speed: 100
  };

  const STRIP = [
    "anticheat", "ac_token", "ac_sig", "tp_token",
    "tenprotect", "garena_ac", "frida_detect",
    "jailbreak_check", "proxy_detect", "mitm_flag",
    "signature", "sig", "hash_check", "integrity",
    "verify", "attest", "debug_check", "hook_detect"
  ];

  function walk(o) {
    if (o === null || typeof o !== "object") return o;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) o[i] = walk(o[i]);
      return o;
    }
    for (const k in o) {
      const kl = k.toLowerCase();
      if (STRIP.indexOf(kl) !== -1) { delete o[k]; continue; }
      if (FORCE.hasOwnProperty(k)) { o[k] = FORCE[k]; continue; }
      if (typeof o[k] === "object") o[k] = walk(o[k]);
    }
    return o;
  }

  try { $done({ body: JSON.stringify(walk(j)) }); }
  catch (e) { $done({}); }
})();