// Cloudflare Pages API: POST /api/resolve
// 多通道高并发流媒体直链解析与防试听验证引擎

async function raceFirstValid(promises) {
    return new Promise((resolve) => {
        let remaining = promises.length;
        if (remaining === 0) return resolve(null);
        for (const p of promises) {
            Promise.resolve(p).then((res) => {
                if (res && res.url) {
                    resolve(res);
                } else {
                    remaining--;
                    if (remaining === 0) resolve(null);
                }
            }).catch(() => {
                remaining--;
                if (remaining === 0) resolve(null);
            });
        }
    });
}

// 探针 1: 海棠主力 SVIP 高速通道
async function probeHaitang(rid) {
    try {
        const url = `https://musicapi.haitangw.net/music/kw.php?type=mp3&id=${rid}&level=standard`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const purl = resp.url;
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        if (purl && purl.startsWith('http') && !purl.includes('musicapi.haitangw.net')) {
            if (cl >= 600000 || cl === 0) {
                return { url: purl, source_id: 'kw_haitang', source_name: '海棠酷我通道', bytes: cl };
            }
        }
    } catch (_) {}
    return null;
}

// 探针 2: 车机原生极速直链通道
async function probeNxinxz(rid) {
    try {
        const url = `http://music.nxinxz.com/kw.php?id=${rid}&level=standard&type=mp3`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const purl = resp.url;
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        if (purl && purl.startsWith('http') && !purl.includes('music.nxinxz.com')) {
            if (cl >= 600000 || cl === 0) {
                return { url: purl, source_id: 'kw_nxinxz', source_name: '车机直链通道', bytes: cl };
            }
        }
    } catch (_) {}
    return null;
}

// 探针 3: 海棠备用穿透通道
async function probeHaitangCc(rid) {
    try {
        const url = `https://music.haitangw.cc/kw.php?type=mp3&id=${rid}&level=standard`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const purl = resp.url;
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        if (purl && purl.startsWith('http') && !purl.includes('music.haitangw.cc')) {
            if (cl >= 600000 || cl === 0) {
                return { url: purl, source_id: 'kw_haitang_cc', source_name: '海棠备用通道', bytes: cl };
            }
        }
    } catch (_) {}
    return null;
}

// 探针 4: 网易云标准通道
async function probeNetease(id) {
    try {
        const url = `https://api.injahow.cn/meting/?server=netease&type=url&id=${id}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const purl = resp.url;
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        if (purl && purl.includes('music.126.net')) {
            if (cl >= 1000000 || cl === 0) {
                return { url: purl, source_id: 'netease', source_name: '网易云官方通道', bytes: cl };
            }
        }
    } catch (_) {}
    return null;
}

export async function onRequest(context) {
    let cand = {};
    if (context.request.method === 'POST') {
        try {
            cand = await context.request.json();
        } catch (_) {}
    } else {
        const { searchParams } = new URL(context.request.url);
        cand = {
            id: searchParams.get('id'),
            platform: searchParams.get('platform') || 'kw',
            title: searchParams.get('title'),
            artist: searchParams.get('artist')
        };
    }

    const sid = cand.id || '';
    const plat = cand.platform || 'kw';

    // 1. 如果是酷我源，执行三路并发竞速
    if (plat === 'kw' && sid) {
        const winner = await raceFirstValid([
            probeHaitang(sid),
            probeNxinxz(sid)
        ]);
        if (winner) {
            return new Response(JSON.stringify({ success: true, ...winner }), {
                headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
            });
        }

        // 备用阶梯重试
        const backup = await probeHaitangCc(sid);
        if (backup) {
            return new Response(JSON.stringify({ success: true, ...backup }), {
                headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
            });
        }
    }

    // 2. 如果是网易云源，或酷我源失败后的兜底尝试
    if (plat === 'ne' && sid) {
        const neRes = await probeNetease(sid);
        if (neRes) {
            return new Response(JSON.stringify({ success: true, ...neRes }), {
                headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
            });
        }
    }

    return new Response(JSON.stringify({
        success: false,
        error: "所有音源通道解析均超时或未通过完整音频校验 (已过滤试听)"
    }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
}
