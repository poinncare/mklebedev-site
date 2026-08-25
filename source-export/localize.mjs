import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const exportDir = path.join(root, 'source-export');
const assetsDir = path.join(exportDir, 'assets');
const sourcePath = path.join(exportDir, 'source.html');
const localPath = path.join(exportDir, 'local', 'index.html');
const rootPath = path.join(root, 'index.html');

await mkdir(assetsDir, { recursive: true });
await mkdir(path.dirname(localPath), { recursive: true });

const decodeHtml = (value) => value
  .replaceAll('&quot;', '"')
  .replaceAll('&#34;', '"')
  .replaceAll('&amp;', '&')
  .replaceAll('&#38;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');

const normaliseUrl = (value) => {
  try {
    const url = new URL(decodeHtml(value));
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
};

const shouldLocalise = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.pathname === '/') return false;
    const host = parsed.hostname;
    return [
      'static.tildacdn.com',
      'thb.tildacdn.com',
      'neo.tildacdn.com',
      'cdn.envybox.io',
    ].includes(host);
  } catch {
    return false;
  }
};

const findUrls = (text) => {
  const found = new Set();
  // Tilda stores gallery JSON inside HTML attributes, where quotes are
  // encoded as &quot;. Stop at either a real delimiter or the encoded one;
  // otherwise one match can swallow every subsequent gallery image URL.
  const re = /https?:\/\/[^\s"'<>]+?(?=(?:&quot;|&#34;|[\s"'<>]|$))/g;
  for (const match of text.matchAll(re)) {
    const raw = match[0].replace(/[),;\]}]+$/g, '');
    const value = decodeHtml(raw);
    if (shouldLocalise(value)) found.add(value);
  }
  return found;
};

const extensionFor = (url, contentType = '') => {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname).toLowerCase();
  if (ext && ext.length <= 8) return ext;
  if (contentType.includes('javascript')) return '.js';
  if (contentType.includes('css')) return '.css';
  if (contentType.includes('svg')) return '.svg';
  if (contentType.includes('json')) return '.json';
  return '.bin';
};

const filenameFor = (url, contentType = '') => {
  const digest = createHash('sha1').update(normaliseUrl(url) ?? url).digest('hex').slice(0, 16);
  return `${digest}${extensionFor(url, contentType)}`;
};

const localMap = new Map();
const downloaded = [];
const failed = [];
const queue = [];

const addUrl = (url) => {
  const value = decodeHtml(url);
  const key = normaliseUrl(value);
  if (!key || !shouldLocalise(value) || localMap.has(key)) return;
  queue.push(value);
  localMap.set(key, null);
};

for (const url of findUrls(await readFile(sourcePath, 'utf8'))) addUrl(url);
const dynamicTildaResources = [
  'https://static.tildacdn.com/css/tilda-zero-form-errorbox.min.css',
  'https://static.tildacdn.com/css/tilda-zero-form-horizontal.min.css',
  'https://static.tildacdn.com/js/tilda-conditional-form-1.0.min.js',
];
for (const url of dynamicTildaResources) addUrl(url);

while (queue.length) {
  const url = queue.shift();
  const key = normaliseUrl(url);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; local-export/1.0)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = filenameFor(url, contentType);
    await writeFile(path.join(assetsDir, filename), buffer);
    const localUrl = `/source-export/assets/${filename}`;
    localMap.set(key, localUrl);
    downloaded.push({ url, localUrl, bytes: buffer.length, contentType });
    if (contentType.includes('css') || contentType.includes('javascript') || /\.(css|js)(?:\?|$)/i.test(url)) {
      const sourceCode = buffer.toString('utf8');
      for (const child of findUrls(sourceCode)) addUrl(child);
    }
  } catch (error) {
    // Keep a previously captured asset if the CDN has a transient network
    // failure on a later repeat of the export.
    const cachedFilename = filenameFor(url);
    try {
      await readFile(path.join(assetsDir, cachedFilename));
      localMap.set(key, `/source-export/assets/${cachedFilename}`);
      downloaded.push({ url, localUrl: `/source-export/assets/${cachedFilename}`, cached: true });
    } catch {
      localMap.delete(key);
      failed.push({ url, error: String(error) });
    }
  }
}

const rewriteText = (text) => {
  let result = text;
  for (const [key, localUrl] of [...localMap].sort((a, b) => b[0].length - a[0].length)) {
    if (!localUrl) continue;
    const original = key;
    const variants = new Set([original, `${original}?t=1748951665`]);
    for (const variant of variants) result = result.split(variant).join(localUrl);
  }
  return result;
};

// CSS files can contain their own font/background URLs. Rewrite those too;
// otherwise the page looks correct only while the original CDN is reachable.
for (const item of downloaded.filter((entry) => /css/i.test(entry.contentType ?? '') || /javascript/i.test(entry.contentType ?? '') || /\.(css|js)(?:\?|$)/i.test(entry.url))) {
  const assetName = item.localUrl.split('/').pop().split('?')[0];
  const assetPath = path.join(assetsDir, assetName);
  const css = await readFile(assetPath, 'utf8');
  await writeFile(assetPath, rewriteText(css));
}

// Tilda zero-form code requests a small set of resources by original
// basename at runtime. Keep those paths local as well.
for (const url of dynamicTildaResources) {
  const localUrl = localMap.get(normaliseUrl(url));
  if (!localUrl) continue;
  const sourceAsset = path.join(assetsDir, localUrl.split('/').pop().split('?')[0]);
  const targetDir = path.join(assetsDir, new URL(url).pathname.includes('/css/') ? 'css' : 'js');
  const targetPath = path.join(targetDir, path.basename(new URL(url).pathname));
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, await readFile(sourceAsset));
}

const sourceHtml = await readFile(sourcePath, 'utf8');
const localHtml = rewriteText(sourceHtml)
  .replaceAll('https://static.tildacdn.com', 'https://static.tildacdn.com')
  .replace(/<!--\s*Marquiz script start\s*-->[\s\S]*?<!--\s*Marquiz script end\s*-->/gi, '')
  .replace(/href=(["'])#popup:marquiz_[^"']*\1/gi, 'href="#rec869590255"')
  .replace(/window\.ws_OnQuizSendLead\s*=\s*function\s*\(data\)\s*\{send_ct_envybox\('Квиз Envybox', data\);\};?/gi, '')
  .replace(/<script[^>]+src="https:\/\/mc\.yandex\.ru[^>]+><\/script>/g, '')
  .replace(/<script[^>]+src="https:\/\/mod\.calltouch\.ru[^>]+><\/script>/g, '')
  .replace('</head>', '<link rel="stylesheet" href="/source-export/mobile-overrides.css" type="text/css" media="all" /></head>');

// Make Tilda's runtime resource resolver point at the local basename copies.
const localResolverPatch = /"https:\/\/static\.tildacdn\."\+t_zeroForms__getRootZone\(\)/g;
const localAssetScripts = await Promise.all(downloaded
  .filter((entry) => /javascript/i.test(entry.contentType ?? '') || /\.js(?:\?|$)/i.test(entry.url))
  .map(async (entry) => {
    const assetName = entry.localUrl.split('/').pop().split('?')[0];
    const assetPath = path.join(assetsDir, assetName);
    const source = await readFile(assetPath, 'utf8');
    return { assetName, source };
  }));
for (const script of localAssetScripts) {
  const patched = script.source.replace(localResolverPatch, '"/source-export/assets"');
  if (patched !== script.source) await writeFile(path.join(assetsDir, script.assetName), patched);
}

await writeFile(localPath, localHtml);
await writeFile(rootPath, localHtml);
await writeFile(path.join(exportDir, 'local-manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'https://mklebedev.ru/',
  downloaded,
  failed,
}, null, 2));

console.log(JSON.stringify({ downloaded: downloaded.length, failed: failed.length, localHtmlBytes: localHtml.length }, null, 2));
if (failed.length) console.log(failed.slice(0, 20));
