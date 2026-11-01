// Cloudflare Pages API: GET /api/lyric
// 通用歌词解析器：返回按时间对齐的毫秒级歌词数组 [{ time: float, text: string }]

function parseLrc(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let match;
        const times = [];
        let lastIndex = 0;

        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(line)) !== null) {
            const m = parseInt(match[1], 10);
            const s = parseInt(match[2], 10);
            const ms = match[3] ? (match[3].length === 2 ? parseInt(match[3], 10) * 10 : parseInt(match[3], 10)) : 0;
            times.push(m * 60 + s + ms / 1000);
            lastIndex = timeRegex.lastIndex;
        }

        const text = line.slice(lastIndex).trim();
        if (text && times.length > 0) {
            for (const t of times) {
                result.push({ time: Math.round(t * 100) / 100, text });
            }
        }
    }

    result.sort((a, b) => a.time - b.time);
    return result;
}

export async function onRequestGet(context) {
    const { searchParams } = new URL(context.request.url);
    const sid = searchParams.get('id') || '';
    const plat = searchParams.get('platform') || 'kw';
    const title = searchParams.get('title') || '';
    const artist = searchParams.get('artist') || '';

    let lrcRaw = "";

    // 1. 若为网易云 ID
    if (plat === 'ne' && sid) {
        try {
            const url = `http://music.163.com/api/song/lyric?os=pc&id=${sid}&lv=-1`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await resp.json();
            lrcRaw = data.lrc?.lyric || "";
        } catch (_) {}
    }

    // 2. 若为酷我 ID
    if (!lrcRaw && plat === 'kw' && sid) {
        try {
            const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${sid}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await resp.json();
            const lrcList = data.data?.lrclist || [];
            if (lrcList.length > 0) {
                const formatted = lrcList.map(it => {
                    const sec = parseFloat(it.time || 0);
                    const m = Math.floor(sec / 60);
                    const s = (sec % 60).toFixed(2);
                    return `[${String(m).padStart(2, '0')}:${s.padStart(5, '0')}] ${it.lineLyric || ''}`;
                }).join('\n');
                lrcRaw = formatted;
            }
        } catch (_) {}
    }

    // 3. 通用搜索网易云歌词兜底
    if (!lrcRaw && (title || artist)) {
        try {
            const q = `${title} ${artist}`.trim();
            const sUrl = `http://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=3`;
            const resp = await fetch(sUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await resp.json();
            const firstId = data.result?.songs?.[0]?.id;
            if (firstId) {
                const lUrl = `http://music.163.com/api/song/lyric?os=pc&id=${firstId}&lv=-1`;
                const lResp = await fetch(lUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const lData = await lResp.json();
                lrcRaw = lData.lrc?.lyric || "";
            }
        } catch (_) {}
    }

    const lines = parseLrc(lrcRaw);

    return new Response(JSON.stringify(lines), {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=604800"
        }
    });
}
