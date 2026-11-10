import t2sMap from './t2s_map.js';

const FORBIDDEN_KWS = [
  'cover',
  '翻唱',
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
];

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

/**
 * 多维歌名/歌手/时长匹配打分模型 (及格线 60 分)。
 * 用于多平台搜索过滤与 search 型音源防翻唱/防串曲门禁。
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
  const tSimple = toSimple(candTitle || '').toLowerCase();
  const alSimple = toSimple(candAlbum || '').toLowerCase();
  const artSimple = toSimple(candArtist || '').toLowerCase();

  const targetTSimp = toSimple(targetTitle || '').toLowerCase();
  const targetArtSimp = toSimple(targetArtist || '').toLowerCase();

  let score = 0.0;

  // 1. 负面关键词惩罚 (-60分；Live/现场版降权 -15 分，确保录音室原版稳居前列)
  const targetAllText = `${targetTSimp} ${targetArtSimp}`;
  const candAllText = `${tSimple} ${alSimple} ${artSimple}`;
  for (const kw of FORBIDDEN_KWS) {
    if (candAllText.includes(kw) && !targetAllText.includes(kw)) {
      score -= 60.0;
      break;
    }
  }
  for (const liveKw of ['live', '现场', '演唱会']) {
    if (candAllText.includes(liveKw) && !targetAllText.includes(liveKw)) {
      score -= 15.0;
      break;
    }
  }

  // 2. 歌名核心词匹配 (最高 45 分)
  if (targetTitle) {
    const cClean = cleanPunctuation(cleanBrackets(tSimple));
    const tClean = cleanPunctuation(cleanBrackets(targetTSimp));

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
      }
    }

    if (tTokens.length > 0) {
      const tokenRatio = Math.min(1.0, matchedTokens / tTokens.length);
      score += 35.0 * tokenRatio;
    } else {
      score += 20.0;
    }
  } else {
    score += 20.0;
  }

  // 4. 专辑与音轨时长容差
  if (candAlbum && alSimple.length > 1) {
    score += 10.0;
  }
  const cd = Number(candDuration) || 0;
  const td = Number(targetDuration) || 0;
  if (cd > 0 && td > 0) {
    const diff = Math.abs(cd - td);
    if (diff <= 5) score += 5.0;
    else if (diff > 25) score -= 25.0;
  } else if (cd > 0) {
    score += 5.0;
  }

  return { score, isMatch: score >= 60.0 };
}

/**
 * 音源响应元数据防串曲校验：
 * - search 模式强制歌名/歌手及格 (>=60)
 * - id 模式若接口返回了歌名字段，则校验歌名与目标歌名兼容（拦截无视 ID 固定返同一首歌的假源）
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
