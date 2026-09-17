/* Offline browser regression: real voting controls and count helpers; no backend requests.
 * Run: rtk proxy node apps/mobile/scripts/verify-commsuni-votes.cjs
 * Needs an installed Chrome/Chromium (or BROWSER_BIN). No live APIs, credentials, or installs.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.resolve(root, '../api/package.json'));
const esbuild = createRequire(apiRequire.resolve('tsx'))('esbuild');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tvwatch-votes-'));
const candidates = [
  process.env.BROWSER_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = candidates.find((value) => value && fs.existsSync(value));
if (!browser) throw Error('Set BROWSER_BIN to an installed Chrome/Chromium binary.');
const stubs = {
  hooks: 'export const useFeatureFlags=()=>({data:{comment_translation:false}});',
  comms:
    "export const useCommsUniScope=()=>({ready:true,key:['fixture',window.fixtureUser||'user']});export const useCommsUniOperation=()=>({data:undefined});",
  client:
    "export const api={get:async path=>{if(!path.endsWith('/media'))throw Error('Unexpected fixture read');window.fixtureMediaRequests++;return {url:window.fixtureMediaUrl}},post:()=>{throw Error('No writes allowed in fixture')}};",
  appearance:
    "import {buildTokens} from '@tvwatch/shared';export const useAppearance=()=>({tokens:buildTokens(window.fixtureTheme||'dark'),resolvedLocale:'en'});",
  primitives:
    "import React from 'react';import {Text} from 'react-native';import {buildTokens} from '@tvwatch/shared';export const APP_ICON={uri:\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%2212%22%20fill%3D%22%23bc4c92%22%2F%3E%3C%2Fsvg%3E\"};export function T({children,variant,muted,style,...rest}){const t=buildTokens(window.fixtureTheme||'dark');return <Text {...rest} style={[{fontSize:variant==='micro'?12:variant==='caption'?14:16,color:muted?t.textMuted:t.textPrimary},style]}>{children}</Text>}",
  image:
    "import React from 'react';export function Image(p){return <img data-media={p.source?.cacheKey?.startsWith('commsuni:')?'true':undefined} src={p.source?.uri} alt={p.accessibilityLabel||''} style={{display:'block',objectFit:p.contentFit==='cover'?'cover':'contain',...p.style}} onLoad={e=>p.onLoad?.({source:{width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight}})} onError={p.onError}/>}",
  icons:
    "import React from 'react';export function Ionicons(p){return <span style={{fontSize:p.size,color:p.color}}>{p.name==='ellipsis-horizontal'?'⋯':p.name?.startsWith('heart')?'♡':'○'}</span>}",
  svg: "import React from 'react';export default function Svg({children,testID,...p}){return <svg {...p} data-testid={testID}>{children}</svg>}export const Circle=p=><circle {...p}/>;export const Path=p=><path {...p}/>;",
  i18n: "import labels from './locales/en/comments.json';export const useTranslation=()=>({t:key=>key.startsWith('comments:')?labels[key.slice(9)]||key:key==='common:moreOptions'?'More options':key});",
  viewer: 'export const MediaViewer=()=>null;',
  crypto: "export const randomUUID=()=>'mock-id';",
};
stubs.primitives +=
  "\nexport function PosterImage({style}){return <div style={{background: '#8996a6',...style}}/>}";
stubs.haptics =
  "export const ImpactFeedbackStyle={Light:'light'};export const impactAsync=async()=>{};";
stubs.width = 'export const useContentWidth=()=>window.fixtureWidth;';
const entry =
  "\nimport React,{useState} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {buildTokens} from '@tvwatch/shared';\nimport {StarRatingControl} from './components/voting/StarRatingControl';\nimport {DeviceTiles} from './components/voting/DeviceTiles';\nimport {ReactionGrid} from './components/voting/ReactionGrid';\nimport {FavoriteCharacterVote} from './components/voting/FavoriteCharacterVote';\nimport {recomputeVoteSection,recomputeReactionSection,recomputeCharacterSection} from './api/vote-optimism';\nimport {REACTION_ORDER} from './components/voting/meta';\nimport common from './locales/en/common.json';\nimport episode from './locales/en/episode.json';\nconst params=new URLSearchParams(location.search);\nwindow.fixtureTheme=params.get('theme')||'dark';\nwindow.fixtureWidth=params.get('kind')==='narrow'?340:680;\nconst tokens=buildTokens(window.fixtureTheme);\ndocument.body.style.background=tokens.background;\ndocument.getElementById('app').style.width=window.fixtureWidth+'px';\nconst t=(key,vars={})=>{\n const [namespace,leaf]=key.split(':');\n let value=leaf.split('.').reduce((value,part)=>value?.[part],{common,episode}[namespace])??key;\n return String(value).replace(/{{(\\w+)}}/g,(_,name)=>String(vars[name]??''));\n};\nconst initial={\n rating:{aggregateSource:'commsuni',userVote:'5',countedUserVote:'5',total:3,\n   options:['1','2','3','4','5'].map(value=>({value,count:value==='5'?3:0}))},\n device:{aggregateSource:'commsuni',userVote:'TV',countedUserVote:'TV',total:3,\n   options:['PHONE','TABLET','COMPUTER','TV'].map(value=>({value,count:value==='TV'?2:value==='PHONE'?1:0}))},\n reaction:{aggregateSource:'commsuni',userVotes:['AMUSED'],countedUserVotes:['AMUSED'],totalKind:'selections',total:4,\n   options:REACTION_ORDER.map(value=>({value,count:value==='AMUSED'?2:['SHOCKED','THRILLED'].includes(value)?1:0}))},\n character:{aggregateSource:'commsuni',userVote:'a',countedUserVote:'a',total:6,\n   options:[{castId:'a',count:3},{castId:'b',count:1}],\n   unmappedOptions:[{key:'actor:other',name:'Guest performer',character:'Guest',imageUrl:null,count:2}]}\n};\nconst cast=[{id:'a',creditId:'a',name:'Rebecca Ferguson',character:'Juliette',order:0,votes:0},\n {id:'b',creditId:'b',name:'Common',character:'Sims',order:1,votes:0}];\nfunction App(){\n const [state,setState]=useState(initial);window.voteState=state;\n const [pending,setPending]=useState(false);window.setPending=setPending;\n return <div style={{padding:12,color:tokens.textPrimary,background:tokens.cardBackground,borderRadius:16}}>\n <div id=\"stars\"><h3>Rating</h3><StarRatingControl t={t} section={state.rating} pending={pending}\n onSelect={value=>setState(old=>({...old,rating:recomputeVoteSection(old.rating,String(value))}))}/></div>\n <div id=\"device\"><h3>How did you watch?</h3><DeviceTiles t={t} section={state.device} pending={pending}\n onSelect={value=>setState(old=>({...old,device:recomputeVoteSection(old.device,value)}))}/></div>\n <div id=\"reaction\"><h3>Emotions</h3><ReactionGrid t={t} section={state.reaction} pending={pending}\n onSelect={value=>setState(old=>({...old,reaction:recomputeReactionSection(old.reaction,value)}))}/></div>\n <div id=\"character\"><h3>Favorite character</h3><FavoriteCharacterVote t={t} section={state.character} cast={cast} pending={pending}\n onSelect={value=>setState(old=>({...old,character:recomputeCharacterSection(old.character,value)}))}/></div>\n </div>;\n}\ncreateRoot(document.getElementById('app')).render(<App/>);\nconst delay=ms=>new Promise(r=>setTimeout(r,ms));\nconst buttons=id=>[...document.querySelectorAll('#'+id+' [role=\"radio\"],#'+id+' [role=\"button\"]')];\nconst count=(section,key)=>window.voteState[section].options.find(o=>(o.value??o.castId)===key)?.count;\nsetTimeout(async()=>{\n try{\n  buttons('stars')[3].click();await delay(60);\n  const stars=count('rating','4')===1&&count('rating','5')===2&&document.getElementById('stars').textContent.includes('33%');\n  buttons('device')[0].click();await delay(60);\n  const devices=count('device','PHONE')===2&&count('device','TV')===1&&window.voteState.rating.userVote==='4';\n  buttons('reaction')[0].click();await delay(60);\n  const emotions=count('reaction','SHOCKED')===2&&window.voteState.reaction.total===5&&document.getElementById('reaction').textContent.includes('40%');\n  const guest=buttons('character').find(b=>b.textContent.includes('Guest performer'));\n  const before=JSON.stringify(window.voteState.character);guest.click();await delay(30);\n  const unmappedSafe=guest.getAttribute('aria-disabled')==='true'&&JSON.stringify(window.voteState.character)===before&&guest.textContent.includes('Voting unavailable');\n  buttons('character').find(b=>b.textContent.includes('Sims')).click();await delay(60);\n  const characters=count('character','a')===2&&count('character','b')===2&&window.voteState.character.total===6;\n  buttons('character').find(b=>b.textContent.includes('Sims')).click();await delay(60);\n  const cleared=window.voteState.character.userVote===null&&window.voteState.character.total===5&&count('character','a')===2;\n  window.setPending(true);await delay(30);const snapshot=JSON.stringify(window.voteState);\n  buttons('stars')[1].click();buttons('device')[3].click();buttons('reaction')[5].click();\n  await delay(30);const pendingSafe=JSON.stringify(window.voteState)===snapshot;window.setPending(false);await delay(30);\n  const ok=stars&&devices&&emotions&&characters&&cleared&&unmappedSafe&&pendingSafe;\n  document.getElementById('result').textContent=JSON.stringify({ok,theme:window.fixtureTheme,width:window.fixtureWidth,stars,devices,emotions,characters,cleared,unmappedSafe,pendingSafe});\n }catch(error){document.getElementById('result').textContent=JSON.stringify({ok:false,error:String(error)});}\n},200);\n";
const mappings = [
  ['^expo-haptics$', 'haptics'],
  ['/hooks/useContentWidth$', 'width'],
  ['/api/hooks$', 'hooks'],
  ['/api/commsuni$', 'comms'],
  ['/api/client$', 'client'],
  ['/context/PreferencesProvider$', 'appearance'],
  ['/primitives$', 'primitives'],
  ['^expo-image$', 'image'],
  ['^@expo/vector-icons$', 'icons'],
  ['^react-native-svg$', 'svg'],
  ['^react-i18next$', 'i18n'],
  ['/MediaViewer$', 'viewer'],
  ['^expo-crypto$', 'crypto'],
];

async function main() {
  await esbuild.build({
    absWorkingDir: root,
    tsconfigRaw: { compilerOptions: { jsx: 'react' } },
    stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    bundle: true,
    outfile: path.join(out, 'bundle.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'transform',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { 'react-native': 'react-native-web' },
    plugins: [
      {
        name: 'offline-fixtures',
        setup(build) {
          for (const [filter, key] of mappings)
            build.onResolve({ filter: new RegExp(filter) }, () => ({
              path: key,
              namespace: 'fixture',
            }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents: stubs[args.path],
            loader: 'tsx',
            resolveDir: root,
          }));
        },
      },
    ],
  });
  fs.writeFileSync(
    path.join(out, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app" style="width:680px"></main><pre id="result"></pre><script src="bundle.js"></script></body></html>',
  );
  for (const theme of ['dark', 'light'])
    for (const kind of ['wide', 'narrow']) {
      const url =
        require('node:url').pathToFileURL(path.join(out, 'index.html')).href +
        '?theme=' +
        theme +
        '&kind=' +
        kind;
      const dom = execFileSync(
        browser,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--disable-background-networking',
          '--disable-component-update',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          '--user-data-dir=' + path.join(out, 'profile-' + theme + '-' + kind),
          '--window-size=720,980',
          '--virtual-time-budget=4500',
          '--dump-dom',
          url,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 45000,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      fs.writeFileSync(path.join(out, theme + '-' + kind + '.html'), dom);
      const match = /<pre id="result"[^>]*>(.*?)<\/pre>/s.exec(dom);
      if (!match) throw Error('No browser result; artifacts: ' + out);
      const result = JSON.parse(match[1]);
      console.log(JSON.stringify(result));
      if (!result.ok) throw Error('Voting regression; artifacts: ' + out);
    }
  console.log('Artifacts: ' + out);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
