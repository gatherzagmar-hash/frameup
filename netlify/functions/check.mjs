// FrameUp – sprawdzanie filmu z TikToka (Netlify Function).
// GET /api/check?url=<link do TikToka>
// Pobiera publiczną stronę filmu i wyciąga z niej dane o jakości i statystyki.
// Uwaga: TikTok może zmienić stronę albo blokować zapytania – wtedy zwracamy czytelny błąd.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }
});

function isTikTok(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return h === 'tiktok.com' || h.endsWith('.tiktok.com'); } catch { return false; }
}

function pickScript(html, id) {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function findItem(html) {
  const uni = pickScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const it = uni?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (it) return it;
  const sigi = pickScript(html, 'SIGI_STATE');
  if (sigi?.ItemModule) { const first = Object.values(sigi.ItemModule)[0]; if (first) return first; }
  return null;
}

const num = v => (v === undefined || v === null || v === '') ? null : Number(v);

export default async (req) => {
  const raw = new URL(req.url).searchParams.get('url') || '';
  if (!isTikTok(raw)) return json(400, { error: 'Paste a TikTok video link (tiktok.com/...).' });

  let res;
  try {
    res = await fetch(raw, { redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' } });
  } catch {
    return json(502, { error: 'Could not reach TikTok. Try again in a moment.' });
  }
  if (!isTikTok(res.url)) return json(400, { error: 'That link does not lead to a TikTok video.' });
  if (!res.ok) return json(502, { error: `TikTok answered with an error (${res.status}). Try again later.` });

  const html = await res.text();
  const item = findItem(html);
  if (!item || !item.video) return json(404, { error: 'Video data not found. The video may be private, deleted, or TikTok blocked the check.' });

  const v = item.video;
  const stats = item.statsV2 || item.stats || {};
  const variants = (v.bitrateInfo || []).map(b => ({
    name: b.GearName || null,
    quality: b.QualityType ?? null,
    codec: (b.CodecType || '').toLowerCase().includes('265') || (b.CodecType || '').toLowerCase().includes('hevc') ? 'HEVC' : (b.CodecType ? 'H.264' : null),
    bitrateKbps: b.Bitrate ? Math.round(Number(b.Bitrate) / 1000) : null,
    fps: num(b.BitrateFPS) || num(b.FPS) || null,
    width: num(b.PlayAddr?.Width), height: num(b.PlayAddr?.Height),
    sizeMB: b.PlayAddr?.DataSize ? Math.round(Number(b.PlayAddr.DataSize) / 104857.6) / 10 : null
  })).filter(x => x.width && x.height);

  const best = variants.reduce((a, b) => (!a || Math.min(b.width, b.height) > Math.min(a.width, a.height) || (Math.min(b.width, b.height) === Math.min(a.width, a.height) && (b.bitrateKbps || 0) > (a.bitrateKbps || 0))) ? b : a, null);
  // FPS nie jest podawany wprost – próbujemy znaleźć go w nazwie wariantu albo polach wideo.
  const fpsGuess = (best && best.fps) || num(v.fps) || num(v.frameRate) || variants.reduce((m, x) => Math.max(m, x.fps || 0), 0) || null;

  return json(200, {
    id: item.id,
    url: res.url,
    desc: item.desc || '',
    created: item.createTime ? Number(item.createTime) : null,
    author: { username: item.author?.uniqueId || null, name: item.author?.nickname || null, avatar: item.author?.avatarThumb || null },
    cover: v.cover || v.originCover || null,
    stats: { views: num(stats.playCount), likes: num(stats.diggCount), comments: num(stats.commentCount), shares: num(stats.shareCount), saves: num(stats.collectCount) },
    video: {
      duration: num(v.duration), width: num(v.width), height: num(v.height), definition: v.definition || null,
      codec: (v.codecType || '').includes('265') ? 'HEVC' : (v.codecType ? 'H.264' : null),
      bitrateKbps: v.bitrate ? Math.round(Number(v.bitrate) / 1000) : null,
      fps: fpsGuess
    },
    best,
    variants
  });
};

export const config = { path: '/api/check' };
