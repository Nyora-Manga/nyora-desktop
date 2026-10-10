import {el,icon} from 'nyora-shared-ui';

// Destinations are audited app resources, never renderer-supplied URLs.
const links = [
  ['Website','https://nyora.xyz','globe'],
  ['Project on GitHub','https://github.com/Nyora-Manga','github'],
  ['Discord','https://discord.gg/3ZBHA8RtbR','discord'],
  ['License','https://www.apache.org/licenses/LICENSE-2.0','book'],
];

export function buildNativeAbout() {
  const resources=el('nav', {class:'desktop-about-links','aria-label':'Application resources'});
  for(const [label,href,glyph] of links) resources.append(el('a', {
    href,target:'_blank',rel:'noopener noreferrer',class:'btn btn-ghost',title:`${label} — opens in your browser`,
  },icon(glyph),el('span',null,label)));
  return el('section',{class:'settings-section about-section desktop-about'},
    el('h2',null,'Nyora'),
    el('p',{class:'hint'},`Version ${__NYORA_APP_VERSION__}`),
    el('p',null,'A desktop manga reader with a personal library and offline reading.'),
    resources,
  );
}
