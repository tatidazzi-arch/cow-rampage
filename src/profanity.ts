/** Filtro de palavrões (nomes do multiplayer). PT-BR + EN, com leet ambíguo. */

const BAD_TOKENS = new Set([
  // PT-BR: sexual / excremento / ofensas fortes
  'cu', 'cuzinho', 'cuzao', 'cuzona', 'cuzo', 'culhao', 'culha',
  'porra', 'caralho', 'puta', 'puto', 'putas', 'putaria',
  'merda', 'bosta', 'foda', 'fodida', 'fode', 'foder', 'fodido', 'fodiba',
  'pica', 'pinto', 'buceta', 'xota', 'xoxota', 'grelo', 'punheta',
  'siririca', 'gozo', 'gozar', 'tesao', 'arrombado', 'arrombada',
  'corno', 'corna', 'cornudo', 'cornuda', 'vadia', 'vadias', 'piranha',
  'prostituta', 'quenga', 'cachorra', 'cadela', 'viado', 'veado',
  'viadinho', 'viadoni', 'bicha', 'boquete', 'trepar',
  'orgia', 'punheteiro', 'fdp',
  // EN
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'dick', 'pussy',
  'cunt', 'whore', 'slut', 'bastard', 'nigga', 'nigger', 'faggot', 'retard',
  'porn', 'porno', 'xxx', 'hentai',
]);

/** Compostos colados (substrings exatas, sem falso positivo). */
const BAD_COMPOUNDS = [
  'chupacu', 'chupapica', 'filhodaputa', 'filhadaputa', 'vaiamera',
  'tomanocu', 'enfiaocu', 'suckdick', 'motherfucker',
  'cunopal', 'cunopau', 'cunozin', 'cuzin',
];

/** Esqueletos de consoante (p/ c4r4lh0, ckrlh0, cr1h0): contém na ordem. */
const BAD_SKELETONS = ['crlh', 'chpc', 'rrmbd', 'prstt', 'pnhtr', 'crnd'];

function skeleton(w: string): string {
  return w.replace(/[aeiou]/g, '');
}

function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++;
  }
  return j === needle.length;
}

function baseNorm(s: string): string {
  let t = (s ?? '').toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t
    .replace(/@/g, 'a').replace(/!/g, 'i').replace(/\|/g, 'i')
    .replace(/\$/g, 's')
    .replace(/8/g, 'b').replace(/9/g, 'g').replace(/2/g, 'z').replace(/3/g, 'e')
    .replace(/5/g, 's').replace(/4/g, 'a');
  t = t.replace(/ph/g, 'f');
  // repetições de 3+ viram 1 (cuuuu -> cu)
  t = t.replace(/(.)\1{2,}/g, '$1');
  return t;
}

/** Todas as leituras ambíguas (0=o/u, 1=i/l, 7=t/u/i/z). Nomes limpos: 1 só. */
function variants(s: string): string[] {
  const t = baseNorm(s);
  const out = new Set<string>(['']);
  const push = (opts: string[]) => {
    const next = new Set<string>();
    for (const prefix of out) {
      for (const o of opts) next.add(prefix + o);
    }
    out.clear();
    for (const v of next) out.add(v);
  };
  for (const ch of t) {
    if (ch === '0') push(['o', 'u']);
    else if (ch === '1') push(['i', 'l']);
    else if (ch === '7') push(['t', 'u', 'i', 'z']);
    else push([ch]);
  }
  return [...out].slice(0, 64);
}

/** Quase-palavrão: só vale se o original tinha dígito (Porã puro passa). */
const STRICT_DIGIT = new Set(['pora', 'pura']);

/** true se UMA leitura contém palavrão. */
function variantBad(t: string, strict: boolean): boolean {
  if (!t.trim()) return false;
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  if (strict) {
    for (const w of tokens) {
      if (STRICT_DIGIT.has(w)) return true;
    }
  }
  const longBad = [...BAD_TOKENS].filter((b) => b.length >= 4);
  for (const w of tokens) {
    if (BAD_TOKENS.has(w)) return true;
    for (const b of longBad) {
      if (w.includes(b)) return true;
    }
    // esqueleto (ckrlh0 -> ckrlh contém crlh)
    if (w.length >= 5) {
      const sk = skeleton(w);
      if (sk.length >= 4) {
        for (const bs of BAD_SKELETONS) {
          if (isSubsequence(bs, sk)) return true;
        }
      }
    }
  }
  const joined = tokens.join('');
  if (BAD_TOKENS.has(joined)) return true;
  for (const c of BAD_COMPOUNDS) {
    if (joined.includes(c)) return true;
  }
  for (const b of longBad) {
    if (joined.includes(b)) return true;
  }
  return false;
}

/** true se o texto contém palavrão (qualquer leitura). */
export function containsProfanity(text: string): boolean {
  const strict = /\d/.test(text ?? '');
  for (const v of variants(text)) {
    if (variantBad(v, strict)) return true;
  }
  return false;
}

/** Nome seguro pra exibir: troca por fallback se vazio ou sujo (máx 12). */
export function cleanName(name: string, fallback: string): string {
  const t = (name ?? '').trim().slice(0, 12);
  if (!t || containsProfanity(t)) return fallback;
  return t;
}
