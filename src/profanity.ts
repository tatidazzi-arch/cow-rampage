/** Filtro de palavrões (nomes do multiplayer). PT-BR + EN, com leet e acentos. */

/** Tokens proibidos (palavra inteira após normalizar). */
const BAD_TOKENS = new Set([
  // PT-BR: sexual / excremento / ofensas fortes
  'cu', 'cuzinho', 'porra', 'caralho', 'puta', 'puto', 'putaria',
  'merda', 'bosta', 'foda', 'fode', 'foder', 'fodido', 'pica', 'pinto',
  'buceta', 'xota', 'xoxota', 'grelo', 'punheta', 'siririca', 'gozo', 'gozar',
  'tesao', 'arrombado', 'arrombada', 'corno', 'corna', 'vadia', 'piranha',
  'prostituta', 'prostibulo', 'sirigaita', 'quenga', 'cachorra', 'cadela',
  'viado', 'veado', 'bicha', 'boquete', 'chupada', 'trepar', 'transar',
  'orgia', 'punheteiro',
  // EN
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'dick', 'pussy',
  'cunt', 'whore', 'slut', 'bastard', 'nigga', 'nigger', 'faggot', 'retard',
  'porn', 'porno', 'xxx', 'hentai',
]);

/** Compostos sem espaço (só tokens longos, sem falso positivo). */
const BAD_COMPOUNDS = [
  'chupacu', 'chupapica', 'filhodaputa', 'filhadaputa', 'vaiamera',
  'tomanocu', 'enfiaocu', 'suckdick', 'motherfucker',
  'cunopal', 'cunopau', 'cunozin', 'cuzin',
];

function normalize(s: string): string {
  let t = (s ?? '').toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t
    .replace(/4/g, 'a').replace(/@/g, 'a')
    .replace(/3/g, 'e')
    .replace(/1/g, 'i').replace(/!/g, 'i').replace(/\|/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's').replace(/\$/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/2/g, 'z');
  // repetições de 3+ viram 1 (cuuuu -> cu)
  t = t.replace(/(.)\1{2,}/g, '$1');
  return t;
}

/** true se o texto contém palavrão. */
export function containsProfanity(text: string): boolean {
  const t = normalize(text);
  if (!t.trim()) return false;
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  const longBad = [...BAD_TOKENS].filter((b) => b.length >= 4);
  for (const w of tokens) {
    if (BAD_TOKENS.has(w)) return true;
    // embutido em nome maior (pussyslayer): só raiz com 4+ letras
    for (const b of longBad) {
      if (w.includes(b)) return true;
    }
  }
  const joined = tokens.join('');
  // junto exato ("C u" -> "cu"): igual a token proibido, pega
  if (BAD_TOKENS.has(joined)) return true;
  for (const c of BAD_COMPOUNDS) {
    if (joined.includes(c)) return true;
  }
  // separado por ponto/traço (p.u.t.a -> puta): raiz com 4+ letras
  for (const b of longBad) {
    if (joined.includes(b)) return true;
  }
  return false;
}

/** Nome seguro pra exibir: troca por fallback se vazio ou sujo (máx 12). */
export function cleanName(name: string, fallback: string): string {
  const t = (name ?? '').trim().slice(0, 12);
  if (!t || containsProfanity(t)) return fallback;
  return t;
}
