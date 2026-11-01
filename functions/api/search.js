// Cloudflare Pages API: GET /api/search?q=...
// 极简高精度搜索与打分过滤 (纯 V8 标准 ES 模块，0 C库依赖，微秒级执行)

import t2sMap from './t2s_map.js';

function toSimple(txt) {
    if (!txt) return "";
    return txt.split('').map(c => t2sMap[c] || c).join('');
}

function calculateSongMatchScore(candTitle, candArtist, candAlbum, targetTitle, targetArtist, candDuration) {
    const tSimple = toSimple(candTitle || "").toLowerCase();
    const alSimple = toSimple(candAlbum || "").toLowerCase();
    const artSimple = toSimple(candArtist || "").toLowerCase();

    const targetTSimp = toSimple(targetTitle || "").toLowerCase();
    const targetArtSimp = toSimple(targetArtist || "").toLowerCase();

    let score = 0.0;

    // 1. 负面关键词大额惩罚 (-60分)
    const forbiddenKws = [
        'cover', '翻唱', '伴奏', '伴奏版', '纯伴奏', 'instrumental',
        'remix', 'dj', '电音版', '慢摇', '降调', '升调', '片段', '铃声'
    ];
    const targetAllText = `${targetTSimp} ${targetArtSimp}`;
    for (const kw of forbiddenKws) {
        if ((tSimple.includes(kw) || alSimple.includes(kw) || artSimple.includes(kw)) && !targetAllText.includes(kw)) {
            score -= 60.0;
            break;
        }
    }

    // 2. 歌名核心词匹配 (最高 45 分)
    if (targetTitle) {
        const normTarget = targetTSimp.replace(/[\(（\[【].*?[\)）\]】]/g, '').trim();
        const normCand = tSimple.replace(/[\(（\[【].*?[\)）\]】]/g, '').trim();

        const cClean = normCand.replace(/[\s\-_·\.,，。、]+/g, '');
        const tClean = normTarget.replace(/[\s\-_·\.,，。、]+/g, '');

        if (cClean && tClean) {
            if (cClean === tClean) {
                score += 45.0;
            } else if (cClean.includes(tClean) || tClean.includes(cClean)) {
                score += 35.0;
            } else {
                const tKey = tClean.replace(/[过后的之了]+/g, '');
                const cKey = cClean.replace(/[过后的之了]+/g, '');
                if (tKey && cKey && (tKey.includes(cKey) || cKey.includes(tKey))) {
                    score += 30.0;
                } else {
                    const cSet = new Set(cClean.split(''));
                    const tSet = new Set(tClean.split(''));
                    let common = 0;
                    for (const ch of cSet) {
                        if (tSet.has(ch)) common++;
                    }
                    const ratio = common / Math.max(cSet.size, tSet.size, 1);
                    if (ratio >= 0.7) {
                        score += 25.0 * ratio;
                    }
                }
            }
        }
    } else {
        score += 25.0;
    }

    // 3. 歌手 Token 对齐 (最高 35 分)
    if (targetArtist) {
        const cTokens = artSimple.split(/[/,、&+\s\(\)（）]+/).filter(Boolean);
        const tTokens = targetArtSimp.split(/[/,、&+\s\(\)（）]+/).filter(Boolean);

        let matchedTokens = 0;
        for (const t of tTokens) {
            if (cTokens.some(ct => ct === t || (t.length >= 2 && (ct.includes(t) || t.includes(ct))))) {
                matchedTokens += 1;
            } else if (artSimple.includes(t) || t.includes(artSimple)) {
                matchedTokens += 0.8;
            }
        }

        if (tTokens.length > 0) {
            const tokenRatio = Math.min(1.0, matchedTokens / Math.max(1, tTokens.length));
            score += 35.0 * tokenRatio;
        } else {
            score += 20.0;
        }
    } else {
        score += 20.0;
    }

    // 4. 专辑名契合度 (最高 10 分)
    if (candAlbum && alSimple.length > 1) {
        score += 10.0;
    }

    // 5. 音轨时长容差
    if (candDuration && typeof candDuration === 'number') {
        score += 5.0;
    }

    return { score, isMatch: score >= 60.0 };
}

export async function onRequestGet(context) {
    const { searchParams } = new URL(context.request.url);
    const q = (searchParams.get('q') || searchParams.get('keyword') || '').trim();
    if (!q) {
        return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
    }

    const cleanQ = q.replace(/[\(（\[【].*?[\)）\]】]/g, '').trim() || q;
    let targetTitle = (searchParams.get('title') || '').trim();
    let targetArtist = (searchParams.get('artist') || '').trim();

    if (!targetTitle && !targetArtist) {
        const parts = cleanQ.split(/\s+/);
        if (parts.length >= 2) {
            targetTitle = parts.slice(0, parts.length - 1).join(' ');
            targetArtist = parts[parts.length - 1];
        } else {
            targetTitle = cleanQ;
        }
    }

    const searchQ = toSimple(cleanQ);
    const candidates = [];

    try {
        // 主通道：酷我音乐搜索
        const sUrl = `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(searchQ)}&pn=0&rn=12&uid=794762528&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newsearch=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1`;
        const resp = await fetch(sUrl, {
            headers: { 'User-Agent': 'okhttp/3.10.0' }
        });
        const data = await resp.json();
        const abslist = data.abslist || [];

        for (const it of abslist) {
            const sname = it.SONGNAME || '';
            const sart = it.ARTIST || '';
            const salb = it.ALBUM || '';
            const sdur = parseInt(it.DURATION || '0', 10);
            const { score, isMatch } = calculateSongMatchScore(sname, sart, salb, targetTitle, targetArtist, sdur);

            if (isMatch) {
                const rid = (it.MUSICRID || '').replace('MUSIC_', '');
                if (rid) {
                    candidates.push({
                        platform: 'kw',
                        id: rid,
                        title: sname,
                        artist: sart,
                        album: salb,
                        duration: sdur,
                        score: Math.round(score * 10) / 10
                    });
                }
            }
        }
    } catch (e) {
        console.error("Kuwo search failed:", e);
    }

    // 若无匹配，使用网易云兜底搜索
    if (candidates.length === 0) {
        try {
            const neUrl = `http://music.163.com/api/search/get?s=${encodeURIComponent(cleanQ)}&type=1&offset=0&limit=10`;
            const resp = await fetch(neUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await resp.json();
            const songs = data.result?.songs || [];

            for (const s of songs) {
                const sname = s.name || '';
                const sart = (s.artists || []).map(a => a.name).join('/');
                const salb = s.album?.name || '';
                const sdur = s.duration ? Math.round(s.duration / 1000) : 0;
                const { score, isMatch } = calculateSongMatchScore(sname, sart, salb, targetTitle, targetArtist, sdur);

                if (isMatch) {
                    candidates.push({
                        platform: 'ne',
                        id: String(s.id),
                        title: sname,
                        artist: sart,
                        album: salb,
                        duration: sdur,
                        score: Math.round(score * 10) / 10
                    });
                }
            }
        } catch (e) {
            console.error("NetEase search failed:", e);
        }
    }

    // 按得分倒序排列
    candidates.sort((a, b) => b.score - a.score);

    return new Response(JSON.stringify(candidates), {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600"
        }
    });
}
