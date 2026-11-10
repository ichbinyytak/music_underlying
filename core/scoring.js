import t2sMap from './t2s_map.js';

const FORBIDDEN_KWS = [
  'cover',
  '翻唱',
  '原唱',
  '翻自',
  '伴奏',
  '伴奏版',
  '纯伴奏',
  'instrumental',
  'remix',
  'dj',
  '电音版',
  '慢摇',
  '降调',
  '升调',
  '片段',
  '铃声',
  '治愈版',
  '正式版',
  '抖音版',
  '热播版',
  '加速版',
  '3d环绕',
  '环绕版',
  '氛围版',
  '吉他版',
  '钢琴版',
  '女声版',
  '男声版',
];

const LIVE_KWS = ['live', '现场', '演唱会', '音乐节'];

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&apos;|&#39;|&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export function toSimple(txt) {
  if (!txt) return '';
  let out = '';
  for (const ch of String(txt)) {
    out += t2sMap[ch] || ch;
  }
  return out;
}

export function cleanBrackets(txt) {
  return String(txt || '')
    .replace(/[\(（\[【].*?[\)）\]】]/g, '')
    .replace(/[-－—]\s*《.*?》.*$/g, '')
    .replace(/《.*?》(?:电影|电视剧|网剧)?(?:主题曲|插曲|片尾曲|推广曲|原声)?/g, '')
    .trim();
}

export function cleanPunctuation(txt) {
  return String(txt || '').replace(/[\s\-_·.,，。、!！?？~～:：/\\&+'"]+/g, '');
}

export function normalizePlatform(plat) {
  const p = String(plat || '').trim().toLowerCase();
  if (p === 'ne' || p === 'netease') return 'wy';
  if (p === 'qq') return 'tx';
  if (p === 'kuwo') return 'kw';
  if (p === 'kugou') return 'kg';
  if (p === 'migu') return 'mg';
  return p || 'kw';
}

function levenshteinRatio(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const m = s1.length;
  const n = s2.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

/**
 * 工业级多维歌名/歌手/时长匹配打分模型（对标 Amusic，及格线 60 分）。
 */
export function calculateSongMatchScore(
  candTitle,
  candArtist,
  candAlbum = '',
  targetTitle = '',
  targetArtist = '',
  candDuration = 0,
  targetDuration = 0
) {
  const tSimple = toSimple(decodeHtmlEntities(candTitle || '')).toLowerCase();
  const alSimple = toSimple(decodeHtmlEntities(candAlbum || '')).toLowerCase();
  const artSimple = toSimple(decodeHtmlEntities(candArtist || '')).toLowerCase();

  const targetTSimp = toSimple(decodeHtmlEntities(targetTitle || '')).toLowerCase();
  const targetArtSimp = toSimple(decodeHtmlEntities(targetArtist || '')).toLowerCase();

  let score = 0.0;

  // 1. 负面关键词惩罚 (-60分；Live/现场版降权 -15 分)
  const targetAllText = `${targetTSimp} ${targetArtSimp}`;
  const candAllText = `${tSimple} ${alSimple} ${artSimple}`;
  for (const kw of FORBIDDEN_KWS) {
    if (candAllText.includes(kw) && !targetAllText.includes(kw)) {
      score -= 60.0;
      break;
    }
  }
  for (const liveKw of LIVE_KWS) {
    if (candAllText.includes(liveKw) && !targetAllText.includes(liveKw)) {
      score -= 15.0;
      break;
    }
  }

  // 2. 歌名核心词及容错相似度 (最高 45 分)
  if (targetTitle) {
    const cClean = cleanPunctuation(cleanBrackets(tSimple));
    const tClean = cleanPunctuation(cleanBrackets(targetTSimp));

    if (cClean && tClean) {
      if (cClean === tClean) {
        score += 45.0;
      } else if (cClean.includes(tClean) || tClean.includes(cClean)) {
        score += 38.0;
      } else {
        const tKey = tClean.replace(/[过后的之了]+/g, '');
        const cKey = cClean.replace(/[过后的之了]+/g, '');
        if (tKey && cKey && (tKey.includes(cKey) || cKey.includes(tKey))) {
          score += 35.0;
        } else {
          const cSet = new Set(cClean.split(''));
          const tSet = new Set(tClean.split(''));
          let common = 0;
          for (const ch of cSet) {
            if (tSet.has(ch)) common++;
          }
          const jaccard = common / Math.max(cSet.size, tSet.size, 1);
          const editSim = levenshteinRatio(cClean, tClean);
          const bestSim = Math.max(jaccard, editSim);
          if (bestSim >= 0.5) {
            score += 35.0 * bestSim;
          }
        }
      }
    }
  } else {
    score += 25.0;
  }

  // 3. 歌手 Token 对齐 + 错别字容错 (最高 35 分)
  if (targetArtist) {
    const splitRe = /[/,、&+\s\(\)（）]+/;
    const cTokens = artSimple.split(splitRe).filter(Boolean);
    const tTokens = targetArtSimp.split(splitRe).filter(Boolean);

    let matchedTokens = 0;
    for (const t of tTokens) {
      if (
        cTokens.some(
          (ct) => ct === t || (t.length >= 2 && (ct.includes(t) || t.includes(ct)))
        )
      ) {
        matchedTokens += 1;
      } else if (artSimple.includes(t) || t.includes(artSimple)) {
        matchedTokens += 0.8;
      } else if (cTokens.some((ct) => levenshteinRatio(t, ct) >= 0.75)) {
        matchedTokens += 0.8;
      }
    }

    if (tTokens.length > 0) {
      if (matchedTokens === 0) {
        score -= 35.0;
      } else {
        const tokenRatio = Math.min(1.0, matchedTokens / tTokens.length);
        score += 35.0 * tokenRatio;
      }
    } else {
      score += 20.0;
    }
  } else {
    score += 20.0;
  }

  // 4. 专辑与严格时长物理门禁
  if (candAlbum && alSimple.length > 1) {
    score += 10.0;
  }
  const cd = Number(candDuration) || 0;
  const td = Number(targetDuration) || 0;
  if (cd > 0 && td > 0) {
    const diff = Math.abs(cd - td);
    if (diff <= 4) score += 10.0;
    else if (diff <= 8) score += 5.0;
    else if (diff > 15) score -= 80.0; // 绝对拦截翻唱、加长版、Live 现场与残卷
    else if (diff > 10) score -= 25.0;
  } else if (cd > 0) {
    score += 5.0;
  }

  return { score, isMatch: score >= 60.0 };
}

/**
 * 音源响应元数据防串曲校验。
 */
export function isEndpointResponseValid(
  matchMode,
  returnedTitle,
  returnedArtist,
  expectedTitle,
  expectedArtist
) {
  if (!expectedTitle) return true;
  if (matchMode === 'search') {
    const { isMatch } = calculateSongMatchScore(
      returnedTitle,
      returnedArtist,
      '',
      expectedTitle,
      expectedArtist
    );
    return isMatch;
  }
  if (returnedTitle) {
    const a = cleanPunctuation(cleanBrackets(toSimple(returnedTitle).toLowerCase()));
    const b = cleanPunctuation(cleanBrackets(toSimple(expectedTitle).toLowerCase()));
    if (a && b && !a.includes(b) && !b.includes(a)) {
      return false;
    }
    const retLower = toSimple(returnedTitle).toLowerCase();
    const expLower = toSimple(`${expectedTitle} ${expectedArtist || ''}`).toLowerCase();
    for (const kw of FORBIDDEN_KWS) {
      if (retLower.includes(kw) && !expLower.includes(kw)) {
        return false;
      }
    }
  }
  return true;
}
