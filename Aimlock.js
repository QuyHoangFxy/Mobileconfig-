(async function() {
    const url = $request.url;
    if (!url || !(url.includes('freefire') || url.includes('garena'))) {
        $done({});
        return;
    }
    let body = $request.body;
    if (!body) {
        $done({});
        return;
    }
    let newBody = body;
    let modified = false;
    const params = {
        aimAssist: 1,
        autoAim: 1,
        aimLock: 1,
        aimSpeed: 999,
        targetLock: 1,
        snapAim: 1
    };
    for (const [key, value] of Object.entries(params)) {
        const regex = new RegExp(`"${key}"\\s*:\\s*[0-9]+\\.?[0-9]*`, 'gi');
        if (regex.test(newBody)) {
            newBody = newBody.replace(regex, `"${key}":${value}`);
            modified = true;
        } else {
            const insert = `,"${key}":${value}`;
            newBody = newBody.replace(/{/, `{${insert}`);
            modified = true;
        }
    }
    if (modified) {
        $done({ body: newBody });
    } else {
        $done({});
    }
})();