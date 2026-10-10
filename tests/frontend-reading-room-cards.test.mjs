import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { overlayReadingRoomCards } from '../scripts/library-tools-overlay.mjs';
import { overlayNativeMisc } from '../scripts/native-service-overlay.mjs';
import { awaitNativeMutations } from '../scripts/native-mutation-overlay.mjs';

const original = await readFile(new URL('../vendor/web/web/core/ui.js', import.meta.url), 'utf8');
const native = awaitNativeMutations(overlayNativeMisc('core/ui.js', original), 'core/ui.js').source;
const source = overlayReadingRoomCards(native);
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const card = tree.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'card').declaration;

function fixture({ save = async () => {}, favourite = true } = {}) {
  const calls = [], messages = [];
  const el = (tag, props = {}, ...children) => {
    const node = { tag, props, children, events: {}, classList: { add() {} },
      appendChild(child) { this.children.push(child); },
      insertBefore(child) { this.children.unshift(child); },
      addEventListener(name, action) { this.events[name] = action; },
      focus() { calls.push('focus'); }, getBoundingClientRect() { return { left: 10, bottom: 42 }; },
      querySelector(selector) { const classes = selector.split(',').map(s => s.trim().slice(1));
        for (const child of this.children) {
          if (typeof child !== 'object' || !child) continue;
          if (classes.some(name => child.props?.class?.split(' ').includes(name))) return child;
          const nested = child.querySelector?.(selector); if (nested) return nested;
        }
        return null;
      },
    };
    return node;
  };
  let contextActions, menu;
  const deps = { el, store: { cacheManga() {} }, library: { isFavourite: () => favourite, toggleFavourite: save }, toast: message => messages.push(message), applyImage() {},
    desktopMutation: action => action(), navigator: { clipboard: { writeText: text => calls.push(['copy', text]) } },
    attachContextMenu: (node, actions) => { contextActions = actions; }, contextMenu: (items, x, y) => { menu = { items, x, y }; },
  };
  const create = Function('deps', `const {${Object.keys(deps).join(',')}} = deps; ${source.slice(card.start, card.end)}; return card;`)(deps);
  const node = create({ id: 'one', title: 'Blue Garden', source: { name: 'data:ALPHA' } }, manga => calls.push(['open', manga.id]));
  return { node, calls, messages, contextActions: () => contextActions(), menu: () => menu };
}

test('cover opening and overflow are sibling native buttons without an interactive card host', () => {
  const f = fixture();
  assert.equal(f.node.props.role, undefined);
  assert.equal(f.node.props.tabindex, undefined);
  const open = f.node.querySelector('.card-open'), more = f.node.querySelector('.card-overflow');
  assert.equal(open.tag, 'button'); assert.equal(more.tag, 'button');
  assert.equal(open.props['aria-label'], 'Open Blue Garden');
  assert.equal(more.props['aria-label'], 'Actions for Blue Garden');
  assert.equal(more.props['aria-haspopup'], 'menu');
  assert.equal(open.events.keydown, undefined, 'native button keyboard activation must not be duplicated');
  assert.equal(f.node.events.click, undefined, 'overflow click must not also open the title');
  open.events.click();
  assert.deepEqual(f.calls, [['open', 'one']]);
  assert.equal(f.node.querySelector('.card-source').children[0], 'ALPHA');
});

test('overflow shares live context-menu actions and restores its own focus through existing menu behavior', () => {
  const f = fixture(); let stopped = false;
  f.node.querySelector('.card-overflow').events.click({ stopPropagation() { stopped = true; } });
  assert(stopped);
  assert.deepEqual(f.calls, ['focus']);
  assert.deepEqual(f.menu().items.map(item => item.label), f.contextActions().map(item => item.label));
  assert.deepEqual([f.menu().x, f.menu().y], [10, 46]);
});

test('overflow favourite action retains acknowledgement before success and reports native save failure', async () => {
  let resolveSave;
  const pending = new Promise(resolve => { resolveSave = resolve; });
  const f = fixture({ save: () => pending });
  const save = f.contextActions().find(item => item.label === 'Remove from favourites').onClick();
  assert.deepEqual(f.messages, []);
  resolveSave(); await save;
  assert.deepEqual(f.messages, ['Removed from favourites']);
  const failed = fixture({ save: async () => { throw new Error('offline'); } });
  await failed.contextActions()[1].onClick();
  assert.deepEqual(failed.messages, ['Could not update favourites']);
});

test('checked cover transform rejects shared markup drift', () => {
  assert.throws(() => overlayReadingRoomCards(native.replace("{ class: 'card', role: 'button', tabindex: '0' }", "{ class: 'changed' }")), /drift/i);
});
