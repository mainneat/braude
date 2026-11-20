// Transforme un module ES sans dépendance externe en code de script classique, pour l'inliner :
// lignes `import … from '…'` supprimées (y compris sur plusieurs lignes), mot-clé `export` retiré.
const IMPORT = /^import\s[^;]*?from\s*['"][^'"]+['"];?[ \t]*\n?/gm;
const EXPORT = /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm;

export function moduleToScript(src) {
  return String(src).replace(IMPORT, '').replace(EXPORT, '');
}

/** Concatène des modules en un seul script isolé, sûr à placer dans <script>…</script>. */
export function bundleScripts(sources) {
  const body = sources.map(moduleToScript).join('\n');
  return `(() => {\n'use strict';\n${body}\n})();`.replace(/<\/(script)/gi, '<\\/$1');
}
