/** Gerador pseudoaleatório com seed (mulberry32).
 *
 * Todo o conteúdo estático do mundo (prédios, árvores, grama, NPCs,
 * carros, colisores) é gerado com `worldRand`, que tem seed fixa — assim
 * todos os clientes geram EXATAMENTE o mesmo mapa, o que é essencial para
 * o multiplayer (posições sincronizadas só fazem sentido no mesmo mapa).
 *
 * Regra: use `worldRand()` apenas durante a construção inicial do mundo.
 * Lógica de runtime (partículas, IA, respawn, mensagens) continua usando
 * `Math.random()`, pois divergir ali não quebra nada.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RNG da construção do mundo — mesma sequência em todo cliente. */
export const worldRand = mulberry32(0xC0FFEE);
