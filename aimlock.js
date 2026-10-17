'use strict';

const TAG = '[ff]';
const LOG = (s) => console.log(TAG + ' ' + s);
const WARN = (s) => console.warn(TAG + ' ' + s);

function resolveIl2cpp() {
  const names = ['UnityFramework', 'FreeFire', 'GameAssembly', 'il2cpp'];
  for (const n of names) {
    const m = Process.findModuleByName(n);
    if (m) { LOG('module: ' + n + ' @ ' + m.base); return m; }
  }
  const mods = Process.enumerateModules();
  for (const m of mods) {
    if (m.findExportByName('il2cpp_domain_get')) { LOG('module (scan): ' + m.name); return m; }
  }
  return null;
}

const mod = resolveIl2cpp();
if (!mod) { WARN('il2cpp not found — attach after menu loaded'); }

const API = {};
const B = (n, r, a) => {
  const p = mod.findExportByName(n);
  if (!p) return null;
  return new NativeFunction(p, r, a);
};

API.domain_get            = B('il2cpp_domain_get', 'pointer', []);
API.domain_get_assemblies = B('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
API.assembly_get_image    = B('il2cpp_assembly_get_image', 'pointer', ['pointer']);
API.image_get_class_count = B('il2cpp_image_get_class_count', 'uint', ['pointer']);
API.image_get_class       = B('il2cpp_image_get_class', 'pointer', ['pointer', 'uint']);
API.class_get_name        = B('il2cpp_class_get_name', 'pointer', ['pointer']);
API.class_get_methods     = B('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
API.method_get_name       = B('il2cpp_method_get_name', 'pointer', ['pointer']);
API.method_get_param_count= B('il2cpp_method_get_param_count', 'uint', ['pointer']);
API.thread_attach         = B('il2cpp_thread_attach', 'pointer', ['pointer']);
API.gc_disable            = B('il2cpp_gc_disable', 'void', []);

const readCStr = (p) => { try { return p.readCString() || ''; } catch (e) { return ''; } };
const readVec3 = (p) => ({ x: p.readFloat(), y: p.add(4).readFloat(), z: p.add(8).readFloat() });
const writeVec3 = (p, v) => { p.writeFloat(v.x); p.add(4).writeFloat(v.y); p.add(8).writeFloat(v.z); };

let asmCache = null;
function assemblies() {
  if (asmCache) return asmCache;
  const dom = API.domain_get();
  const cnt = Memory.alloc(4);
  const arr = API.domain_get_assemblies(dom, cnt);
  const n = cnt.readU32();
  const list = [];
  for (let i = 0; i < n; i++) {
    const asm = arr.add(i * Process.pointerSize).readPointer();
    list.push(API.assembly_get_image(asm));
  }
  asmCache = list;
  return list;
}

function classExact(name) {
  for (const img of assemblies()) {
    const n = API.image_get_class_count(img);
    for (let i = 0; i < n; i++) {
      const k = API.image_get_class(img, i);
      if (!k.isNull() && readCStr(API.class_get_name(k)) === name) return k;
    }
  }
  return null;
}

function classSub(sub) {
  const out = [];
  const lc = sub.toLowerCase();
  for (const img of assemblies()) {
    const n = API.image_get_class_count(img);
    for (let i = 0; i < n; i++) {
      const k = API.image_get_class(img, i);
      if (k.isNull()) continue;
      const nm = readCStr(API.class_get_name(k));
      if (nm.toLowerCase().indexOf(lc) !== -1) out.push({ k, nm });
    }
  }
  return out;
}

function methodByPattern(klass, pats, argc) {
  if (!klass) return [];
  const it = Memory.alloc(Process.pointerSize);
  const hits = [];
  while (true) {
    const m = API.class_get_methods(klass, it);
    if (m.isNull()) break;
    const nm = readCStr(API.method_get_name(m)).toLowerCase();
    for (const p of pats) {
      if (nm.indexOf(p.toLowerCase()) !== -1) {
        const pc = API.method_get_param_count(m);
        if (argc === undefined || pc === argc) {
          hits.push({ m, nm, pc });
          break;
        }
      }
    }
  }
  return hits;
}

function hook(addr, cb) {
  try { return Interceptor.attach(addr, cb); } catch (e) { WARN('hook: ' + e); return null; }
}

function attachThread() {
  try { API.thread_attach(API.domain_get()); } catch (e) {}
}

function discover() {
  const out = { Character: null, Player: null, Weapon: null, Bullet: null, Aim: null, Bone: null };
  const exact = {
    Character: ['CCharacter', 'Character', 'GCharacter', 'Avatar'],
    Player:    ['CPlayer', 'Player', 'LocalPlayer', 'GPlayer'],
    Weapon:    ['CWeapon', 'Weapon', 'GWeapon'],
    Bullet:    ['CBullet', 'Bullet', 'GBullet'],
    Aim:       ['CAimAssist', 'AimAssist', 'AimTarget', 'CAim'],
    Bone:      ['Bone', 'CBone', 'Transform', 'CTransform']
  };
  for (const [slot, names] of Object.entries(exact)) {
    for (const n of names) {
      const k = classExact(n);
      if (k) { out[slot] = { k, nm: n }; break; }
    }
  }
  const subMap = {
    Character: 'character', Player: 'player', Weapon: 'weapon',
    Bullet: 'bullet', Aim: 'aim', Bone: 'bone'
  };
  for (const [slot, sub] of Object.entries(subMap)) {
    if (out[slot]) continue;
    const hits = classSub(sub);
    if (hits.length) out[slot] = { k: hits[0].k, nm: hits[0].nm };
  }
  return out;
}

const C = discover();
LOG('classes: ' + JSON.stringify(Object.entries(C).reduce((a, [k, v]) => { a[k] = v ? v.nm : null; return a; }, {})));

const HOOKED = { aim: false, head: false, recoil: false, spread: false, assist: false, sticky: false, soft: false };
let headFn = null;
let stickyHold = 0;

const AIM_PAT     = ['aimtarget', 'setaim', 'aimat', 'applyaim', 'aimto', 'targetaim', 'settarget', 'setlock'];
const HEAD_PAT    = ['gethead', 'headpos', 'headbone', 'headtrans', 'headloc', 'bonehead', 'getbonepos', 'headworld'];
const RECOIL_PAT  = ['recoil', 'kick'];
const SPREAD_PAT  = ['spread', 'accuracy', 'deviation'];
const ASSIST_PAT  = ['aimassist', 'autoaim', 'magnet', 'setaimlock', 'setlockhead'];

function findHeadFn() {
  const pool = [C.Player, C.Character, C.Bone].filter(Boolean);
  for (const c of pool) {
    for (const p of HEAD_PAT) {
      const hits = methodByPattern(c.k, [p]);
      if (hits.length) {
        try {
          const ptr = hits[0].m.readPointer();
          if (!ptr.isNull()) {
            headFn = new NativeFunction(ptr, 'pointer', ['pointer']);
            LOG('head fn: ' + hits[0].nm + ' (from ' + c.nm + ')');
            HOOKED.head = true;
            return true;
          }
        } catch (e) {}
      }
    }
  }
  WARN('head fn not found');
  return false;
}

function hookAim() {
  const pool = [C.Character, C.Aim, C.Player].filter(Boolean);
  let target = null;
  for (const c of pool) {
    for (const p of AIM_PAT) {
      const hits = methodByPattern(c.k, [p]);
      if (hits.length) { target = hits[0]; break; }
    }
    if (target) break;
  }
  if (!target) { WARN('aim method not found'); return false; }

  findHeadFn();

  const addr = target.m.readPointer();
  if (addr.isNull()) { WARN('aim method not compiled'); return false; }

  hook(addr, {
    onEnter(args) {
      if (!headFn) return;
      const self = args[0];
      if (self.isNull()) return;
      try {
        const headPtr = headFn(self);
        if (!headPtr.isNull() && args.length >= 2 && !args[1].isNull()) {
          writeVec3(args[1], readVec3(headPtr));
          if (HOOKED.soft) {
            const cur = readVec3(args[1]);
            const hv = readVec3(headPtr);
            const a = 0.35;
            writeVec3(args[1], {
              x: cur.x + (hv.x - cur.x) * a,
              y: cur.y + (hv.y - cur.y) * a,
              z: cur.z + (hv.z - cur.z) * a
            });
          }
          if (HOOKED.sticky) {
            stickyHold = 3;
          }
        }
      } catch (e) {}
    }
  });
  HOOKED.aim = true;
  LOG('hooked aim: ' + target.nm);
  return true;
}

function hookNoRecoil() {
  const t = C.Weapon || C.Bullet;
  if (!t) { WARN('weapon/bullet class missing'); return false; }
  let hit = null;
  for (const p of RECOIL_PAT) {
    const h = methodByPattern(t.k, [p]);
    if (h.length) { hit = h[0]; break; }
  }
  if (!hit) { WARN('recoil not found'); return false; }
  const addr = hit.m.readPointer();
  if (addr.isNull()) return false;
  hook(addr, { onLeave(retval) { try { retval.replace(ptr(0)); } catch (e) {} } });
  HOOKED.recoil = true;
  LOG('hooked recoil: ' + hit.nm);
  return true;
}

function hookNoSpread() {
  const t = C.Weapon || C.Bullet;
  if (!t) return false;
  let hit = null;
  for (const p of SPREAD_PAT) {
    const h = methodByPattern(t.k, [p]);
    if (h.length) { hit = h[0]; break; }
  }
  if (!hit) { WARN('spread not found'); return false; }
  const addr = hit.m.readPointer();
  if (addr.isNull()) return false;
  hook(addr, { onLeave(retval) { try { retval.replace(ptr(0)); } catch (e) {} } });
  HOOKED.spread = true;
  LOG('hooked spread: ' + hit.nm);
  return true;
}

function hookAssist() {
  const t = C.Aim || C.Character;
  if (!t) return false;
  let hit = null;
  for (const p of ASSIST_PAT) {
    const h = methodByPattern(t.k, [p]);
    if (h.length) { hit = h[0]; break; }
  }
  if (!hit) { WARN('assist not found'); return false; }
  const addr = hit.m.readPointer();
  if (addr.isNull()) return false;
  hook(addr, {
    onEnter(args) {
      if (hit.nm.startsWith('set') && args.length >= 2) {
        try { args[1] = ptr(1); } catch (e) {}
      }
    },
    onLeave(retval) {
      if (hit.nm.startsWith('get')) {
        try { retval.replace(ptr(1)); } catch (e) {}
      }
    }
  });
  HOOKED.assist = true;
  LOG('hooked assist: ' + hit.nm);
  return true;
}

rpc.exports = {
  state() {
    return {
      module: mod ? mod.name : null,
      base: mod ? mod.base.toString() : null,
      classes: Object.entries(C).reduce((a, [k, v]) => { a[k] = v ? v.nm : null; return a; }, {}),
      hooked: HOOKED
    };
  },
  scan(sub) { return classSub(sub).map(x => x.nm).slice(0, 60); },
  methods(cls, sub) {
    const k = classExact(cls);
    if (!k) return [];
    return methodByPattern(k, [sub || '']).map(x => x.nm + '/' + x.pc);
  },
  head()     { return findHeadFn(); },
  aim()      { return hookAim(); },
  norecoil() { return hookNoRecoil(); },
  nospread() { return hookNoSpread(); },
  assist()   { return hookAssist(); },
  sticky(on) { HOOKED.sticky = !!on; return HOOKED.sticky; },
  soft(on)   { HOOKED.soft = !!on; return HOOKED.soft; },
  aimlock()  { HOOKED.soft = false; HOOKED.sticky = true; return hookAim(); },
  aimhead()  { HOOKED.soft = false; HOOKED.sticky = true; return hookAim(); },
  aimtrick() { HOOKED.soft = true; HOOKED.sticky = true; return hookAim(); },
  aimcheck() { HOOKED.soft = true; HOOKED.sticky = false; return hookAim(); },
  aimdag()   { HOOKED.soft = false; HOOKED.sticky = true; return hookAim(); },
  all() {
    HOOKED.soft = false;
    HOOKED.sticky = true;
    hookAim(); hookNoRecoil(); hookNoSpread(); hookAssist();
    return HOOKED;
  }
};

attachThread();
LOG('khuon loaded — ff_hook.js ready');
LOG('gọi: rpc.exports.state()  rồi  rpc.exports.all()');