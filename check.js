(function(){
  const url = $response.url || "";
  if (!/(freefiremobile|garena|garenanow|ggblue)/i.test(url)) {
    $done({});
    return;
  }
  const KEY = [
    "anticheat", "ac_token", "ac_sig", "tp_token",
    "tenprotect", "garena_ac", "frida_detect",
    "jailbreak_check", "proxy_detect", "mitm_flag",
    "signature", "sig", "hash_check", "integrity",
    "verify", "attest", "debug_check", "hook_detect"
  ];
  let body = $response.body;
  if (!body) { $done({}); return; }
  let j;
  try { j = JSON.parse(body); } catch (e) { $done({}); return; }
  function scrub(o) {
    if (o === null || typeof o !== "object") return o;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) o[i] = scrub(o[i]);
      return o;
    }
    for (const k in o) {
      if (KEY.indexOf(k.toLowerCase()) !== -1) { delete o[k]; continue; }
      if (typeof o[k] === "object") o[k] = scrub(o[k]);
    }
    return o;
  }
  try { $done({ body: JSON.stringify(scrub(j)) }); }
  catch (e) { $done({}); }
})();