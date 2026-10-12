import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/** Hash curto do commit atual (vai pra tela; 'dev' se não for repo git). */
function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

// base relativa: funciona no GitHub Pages (project page), dominio proprio e preview local.
export default defineConfig({
  base: './',
  define: { __COMMIT__: JSON.stringify(commitHash()) },
});
