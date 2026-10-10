import { parse } from 'acorn';
const LIBRARY_MUTATIONS = new Set(['toggleFavourite','removeFavourite','recordHistory','removeHistory','clearHistory','clearAll','addBookmark','removeBookmark','createCategory','renameCategory','deleteCategory','addToCategory','removeFromCategory','saveMangaPrefs','clearMangaPrefs','markUpdatesSeen','refreshUpdates','saveReadMarks']);
const isFunction = (node) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
export function awaitNativeMutations(source, label) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  const functions = new Set();
  let count = 0;
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ((label === 'screens/reader.js' && node.callee.name === 'savePrefs') || (label === 'screens/details.js' && ['saveOverrides','setRead','markPreviousRead'].includes(node.callee.name)) || (label === 'screens/search.js' && ['pushRecent','clearRecent','setLangPref'].includes(node.callee.name))) && ancestors.at(-1)?.type !== 'AwaitExpression') {
      const fn = ancestors.findLast(isFunction);
      if (!fn) throw new Error('Shared frontend drift: reader preference save outside a callback.');
      edits.push({ at: node.start, text: 'await ' });
      if (!fn.async) functions.add(fn);
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const object = node.callee.object.name;
      const method = node.callee.property.name;
      if ((object === 'library' && LIBRARY_MUTATIONS.has(method)) || (object === 'store' && method === 'set') || (object === 'downloads' && ['saveSettings','enqueue','cancel','cancelAll','retry','remove','clearCompleted','clearAll'].includes(method)) || (object === 'tracking' && ['link','unlink','setEnabled','disconnect','scrobbleAll'].includes(method)) || (object === 'ctx' && ['setRead','markPreviousRead'].includes(method))) {
        const parent = ancestors.at(-1);
        if (parent?.type !== 'AwaitExpression') {
          const fn = ancestors.findLast(isFunction);
          if (!fn) throw new Error(`Shared frontend drift: ${label} mutation outside an awaited UI function.`);
          edits.push({ at: node.start, text: 'await desktopMutation(() => ' }, { at: node.end, text: ')' });
          if (!fn.async) functions.add(fn);
          count++;
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, [...ancestors, node]);
      } else if (value?.type) visit(value, [...ancestors, node]);
    }
  }
  visit(tree);
  for (const fn of functions) {
    // Object shorthand methods require async at the method's start (the AST's
    // function start is its opening parenthesis); shared mutation callers are
    // ordinary declarations/arrows, so drift to a new shorthand fails loudly.
    if (source[fn.start] === '(' && fn.type === 'FunctionExpression') throw new Error(`Shared frontend drift: unsupported method in ${label}`);
    edits.push({ at: fn.start, text: 'async ' });
  }
  edits.sort((a, b) => b.at - a.at);
  for (const edit of edits) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  if (count) source = `import { desktopMutation } from 'nyora-native-services';\n` + source;
  parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  return { source, count };
}
