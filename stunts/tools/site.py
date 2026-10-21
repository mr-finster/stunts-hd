# Builds the static site for Cloudflare Pages (or any static host) into ../dist:
#   python3 stunts/tools/site.py      then, from the repo root:  npx wrangler pages deploy dist --project-name stunts-recomp
# The referrer count: the page pings /_refhit on its own origin (the one-line script in index.html), and a Pages Function
# there passes it on, server-side, so nothing in the page names another host. The Function goes to functions/ at the repo
# root, outside dist/: wrangler takes functions/ from the folder it runs in, and there its source is never served as a
# file. It does nothing until the project has the REF_KEY secret (wrangler pages secret put REF_KEY --project-name stunts-recomp).
# The collector's address is not in the source: it is read from .refhit-url at the repo root (or STUNTS_REF_URL); without
# it, no Function is written.
# Only the page's own code goes in, none of the game: players bring their own copy, and the game's code is made from
# it in their browser (boot.js) with map.json, the names and places tools/mkmap.py takes from the Restunts disassembly.
import json, os, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.dirname(HERE); ROOT = os.path.dirname(SRC); OUT = os.path.join(ROOT, 'dist')
PAGE = ['index.html', 'main.js', 'boot.js', 'x86dec.js', 'exefile.js', 'translate.js', 'map.json', 'setup.js', 'qol.js', 'cpu.js', 'drv86.js', 'dos.js', 'worker.js', 'opl-worklet.js',
        'hires-capture.js', 'hires-view.js', 'hires-grass.js', 'hires-ao.js', 'manifest.webmanifest']
import json
if not json.load(open(os.path.join(SRC, 'map.json'))).get('sum'):
    sys.exit('map.json has no checksum: build it with tools/mkmap.py, giving it GAME.EXE')
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(os.path.join(OUT, 'stunts')); os.makedirs(os.path.join(OUT, 'vendor', 'three'))
# the version: a hash of the page's files, stamped where they say __BUILD__ (each script's address carries it, so a browser's
# cache never mixes two versions; main.js loads the page again when a new version went up while its welcome screen was open)
import hashlib
BUILD = hashlib.sha256(b''.join(open(os.path.join(SRC, f), 'rb').read() for f in PAGE)).hexdigest()[:10]
# and every comment stripped from what's served (tools/strip: the JS's, the shaders' and the CSS's inside its strings, the
# HTML's; translate.js's strings are the code it writes, left as they are: the translation's checksum is of them)
STRIP = os.path.join(HERE, 'strip')
if not os.path.isdir(os.path.join(STRIP, 'node_modules')): subprocess.run(['npm', 'install', '--no-audit', '--no-fund'], cwd=STRIP, check=True)
for f in PAGE:
    dst = os.path.join(OUT, 'stunts', f)
    if f.endswith(('.js', '.html')):
        open(dst, 'w').write(open(os.path.join(SRC, f)).read().replace('__BUILD__', BUILD))
        subprocess.run(['node', os.path.join(STRIP, 'strip.mjs'), dst, dst] + (['--keep-strings'] if f == 'translate.js' else []), check=True)
    else: shutil.copy(os.path.join(SRC, f), dst)
# the welcome page's font (Press Start 2P, OFL), and the trailer when there is one (media/: trailer.mp4, poster.jpg),
# made from the montage, kept out of git (tv.mp4, the old silent loop, is left out)
shutil.copy(os.path.join(SRC, 'logo.webp'), os.path.join(OUT, 'stunts', 'logo.webp'))   # (the welcome page's title)
if os.path.isdir(os.path.join(SRC, 'media')): shutil.copytree(os.path.join(SRC, 'media'), os.path.join(OUT, 'stunts', 'media'), ignore=lambda d, names: [] if os.path.basename(d) == 'readme' else [n for n in names if n not in ('trailer.mp4', 'poster.jpg', 'og.png', 'og.jpg', 'favicon.png', 'apple-touch-icon.png', 'readme')])   # (only what the page uses, and the public README's montage (media/readme/, linked from there; not in git): the rest of media/ is the montage's working files)
else: print('no media/: the welcome page shows the title in place of the trailer')
shutil.copy(os.path.join(ROOT, 'vendor', 'three', 'three.min.js'), os.path.join(OUT, 'vendor', 'three', 'three.min.js'))
os.makedirs(os.path.join(ROOT, 'functions'), exist_ok=True)
REF = os.environ.get('STUNTS_REF_URL') or (open(os.path.join(ROOT, '.refhit-url')).read().strip() if os.path.exists(os.path.join(ROOT, '.refhit-url')) else '')
if REF: open(os.path.join(ROOT, 'functions', '_refhit.js'), 'w').write('''// The page pings /_refhit on its OWN origin; this passes the reading to the collector
// server-side. Nothing in the markup points at another host, so the sites stay unlinkable.
// Only the canonical hostname reports — preview deployments are ignored, so a *.pages.dev
// preview URL can never pollute the real counts.
const SITE = "stunts-recomp.pages.dev";
export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const res = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (url.hostname !== SITE || !ctx.env.REF_KEY) return res;
  const q = new URLSearchParams({ s: SITE, r: url.searchParams.get("r") || "", k: ctx.env.REF_KEY });
  ctx.waitUntil(fetch(%s + "?" + q).catch(() => {}));
  return res;
}
''' % json.dumps(REF))
# SharedArrayBuffer (the game's memory, shared with its worker) needs the page cross-origin isolated
open(os.path.join(OUT, '_headers'), 'w').write(
    '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  X-Content-Type-Options: nosniff\n'
    '/stunts/*.js\n  Cache-Control: public, max-age=300\n/stunts/map.json\n  Cache-Control: public, max-age=300\n'
    '/stunts/\n  Cache-Control: no-cache\n/stunts/index.html\n  Cache-Control: no-cache\n')   # (the page itself always asked after: it names the version)
open(os.path.join(OUT, '_redirects'), 'w').write('/ /stunts/ 302\n')
# (a 404 page: without one, Pages answers every unknown path with index.html, as for a single-page app)
open(os.path.join(OUT, '404.html'), 'w').write('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="/stunts/">Stunts HD</a></p>\n')
n = sum(len(fs) for _, _, fs in os.walk(OUT)); size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT) for f in fs)
print(f'dist: {n} files, {size / 1e6:.1f} MB, version {BUILD}')
