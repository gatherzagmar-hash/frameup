// FrameUp Discord bot + TikTok checker on Cloudflare Workers.
// Vars: DISCORD_PUBLIC_KEY, DISCORD_APP_ID, DISCORD_ANNOUNCE_CHANNEL. Secret: DISCORD_TOKEN. KV binding: VOTES.
// Routes: POST /            Discord interactions
//         GET  /register    (re)register the slash commands
//         GET  /api/check   TikTok check JSON (same as the website uses)

const API = 'https://discord.com/api/v10';
const ORANGE = 0xff4d1a;
const SITE = 'https://frameupmethod.github.io/';
const FOOT = { text: 'FrameUp · frameupmethod.github.io' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const reply = (data, type = 4) => json({ type, data });
const secret = content => reply({ content, flags: 64 });

/* ---------------- commands ---------------- */
const KICK = String(1 << 1), BAN = String(1 << 2), MODERATE = String(1n << 40n), MANAGE = String(1 << 5);
const userOpt = { name: 'user', description: 'Member', type: 6, required: true };
const reasonOpt = { name: 'reason', description: 'Reason (shown in the audit log)', type: 3, required: false, max_length: 300 };
export const COMMANDS = [
  { name: 'website', description: 'Get the link to the FrameUp website', dm_permission: false },
  { name: 'check', description: 'Check a TikTok: views, likes and the quality TikTok serves', dm_permission: false,
    options: [{ name: 'link', description: 'TikTok video link', type: 3, required: true }] },
  { name: 'rate', description: 'Let people rate an edit 1-10', dm_permission: false,
    options: [{ name: 'link', description: 'Link to the edit (TikTok, YouTube, Discord message...)', type: 3, required: true }] },
  { name: 'Rate this edit', type: 3, dm_permission: false },
  { name: 'settings', description: 'Best export settings for TikTok', dm_permission: false,
    options: [{ name: 'app', description: 'Your editing app', type: 3, required: true, choices: [
      { name: 'CapCut', value: 'capcut' }, { name: 'After Effects', value: 'ae' }, { name: 'Premiere Pro', value: 'premiere' }, { name: 'Alight Motion', value: 'alight' }] }] },
  { name: 'roles', description: 'Post the editing app role picker here', default_member_permissions: MANAGE, dm_permission: false },
  { name: 'announce', description: 'Post an announcement in #announcements as FrameUp', default_member_permissions: MANAGE, dm_permission: false,
    options: [{ name: 'ping', description: 'Ping @everyone', type: 5, required: false }] },
  { name: 'kick', description: 'Kick a member', default_member_permissions: KICK, dm_permission: false, options: [userOpt, reasonOpt] },
  { name: 'ban', description: 'Ban a member', default_member_permissions: BAN, dm_permission: false,
    options: [userOpt, reasonOpt, { name: 'delete_days', description: 'Delete their messages from the last N days (0-7)', type: 4, min_value: 0, max_value: 7, required: false }] },
  { name: 'timeout', description: 'Mute a member for some minutes (0 = unmute)', default_member_permissions: MODERATE, dm_permission: false,
    options: [userOpt, { name: 'minutes', description: 'How long (default 10, max 40320 = 28 days)', type: 4, min_value: 0, max_value: 40320, required: false }, reasonOpt] }
];

/* ---------------- helpers ---------------- */
const hex = s => new Uint8Array((s.match(/../g) || []).map(h => parseInt(h, 16)));
async function validSignature(body, sig, ts, pubHex) {
  try {
    let key;
    try { key = await crypto.subtle.importKey('raw', hex(pubHex), { name: 'Ed25519' }, false, ['verify']); }
    catch { key = await crypto.subtle.importKey('raw', hex(pubHex), { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']); }
    const alg = key.algorithm && key.algorithm.name === 'NODE-ED25519' ? 'NODE-ED25519' : 'Ed25519';
    return await crypto.subtle.verify(alg, key, hex(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}
function bot(env) {
  return async (path, method = 'GET', body, reason) => {
    const headers = { authorization: 'Bot ' + env.DISCORD_TOKEN, 'content-type': 'application/json' };
    if (reason) headers['x-audit-log-reason'] = encodeURIComponent(reason.slice(0, 400));
    const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} throw new Error(r.status + (m ? ' ' + m : '')); }
    return r.status === 204 ? null : r.json().catch(() => null);
  };
}
const opt = (i, name) => (i.data.options || []).find(o => o.name === name)?.value;
const canManage = i => { try { return (BigInt(i.member?.permissions || 0) & 0x28n) !== 0n; } catch { return false; } };
const short = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n);
const label = (w, h) => { if (!w || !h) return '–'; const s = Math.min(w, h); return s >= 2160 ? '4K' : s >= 1440 ? '2K' : s + 'p'; };

/* ---------------- TikTok check ---------------- */
const isTikTok = u => { try { const h = new URL(u).hostname.toLowerCase(); return h === 'tiktok.com' || h.endsWith('.tiktok.com'); } catch { return false; } };
const num = v => (v === undefined || v === null || v === '') ? null : Number(v);
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
async function tiktokCheckLocal(raw) {
  if (!isTikTok(raw)) return { status: 400, body: { error: 'Paste a TikTok video link (tiktok.com/...).' } };
  let res;
  try { res = await fetch(raw, { redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' } }); }
  catch { return { status: 502, body: { error: 'Could not reach TikTok. Try again in a moment.' } }; }
  if (!isTikTok(res.url)) return { status: 400, body: { error: 'That link does not lead to a TikTok video.' } };
  if (!res.ok) return { status: 502, body: { error: `TikTok answered with an error (${res.status}). Try again later.` } };
  const item = findItem(await res.text());
  if (!item || !item.video) return { status: 404, body: { error: 'Video data not found. The video may be private, deleted, or TikTok blocked the check.' } };
  const v = item.video, stats = item.statsV2 || item.stats || {};
  const variants = (v.bitrateInfo || []).map(b => ({
    name: b.GearName || null, quality: b.QualityType ?? null,
    codec: /265|hevc/i.test(b.CodecType || '') ? 'HEVC' : (b.CodecType ? 'H.264' : null),
    bitrateKbps: b.Bitrate ? Math.round(Number(b.Bitrate) / 1000) : null,
    fps: num(b.BitrateFPS) || num(b.FPS) || null,
    width: num(b.PlayAddr?.Width), height: num(b.PlayAddr?.Height),
    sizeMB: b.PlayAddr?.DataSize ? Math.round(Number(b.PlayAddr.DataSize) / 104857.6) / 10 : null
  })).filter(x => x.width && x.height);
  const best = variants.reduce((a, b) => (!a || Math.min(b.width, b.height) > Math.min(a.width, a.height) || (Math.min(b.width, b.height) === Math.min(a.width, a.height) && (b.bitrateKbps || 0) > (a.bitrateKbps || 0))) ? b : a, null);
  const fps = (best && best.fps) || num(v.fps) || variants.reduce((m, x) => Math.max(m, x.fps || 0), 0) || null;
  return { status: 200, body: {
    id: item.id, url: res.url, desc: item.desc || '', created: item.createTime ? Number(item.createTime) : null,
    author: { username: item.author?.uniqueId || null, name: item.author?.nickname || null, avatar: item.author?.avatarThumb || null },
    cover: v.cover || v.originCover || null,
    stats: { views: num(stats.playCount), likes: num(stats.diggCount), comments: num(stats.commentCount), shares: num(stats.shareCount), saves: num(stats.collectCount) },
    video: { duration: num(v.duration), width: num(v.width), height: num(v.height), definition: v.definition || null,
      codec: /265/.test(v.codecType || '') ? 'HEVC' : (v.codecType ? 'H.264' : null), bitrateKbps: v.bitrate ? Math.round(Number(v.bitrate) / 1000) : null, fps },
    best, variants
  } };
}
// TikTok sometimes blocks some servers, so if this server is blocked we ask the Netlify checker as a backup.
async function tiktokCheck(raw) {
  const local = await tiktokCheckLocal(raw);
  if (local.status === 200 || local.status === 400) return local;
  try {
    const r = await fetch('https://frameup-pl.netlify.app/api/check?url=' + encodeURIComponent(raw));
    const body = await r.json();
    if (r.ok) return { status: 200, body };
  } catch {}
  return local;
}

async function checkEmbed(url) {
  const { status, body: d } = await tiktokCheck(url);
  if (status !== 200) return { content: '❌ ' + (d.error || 'Check failed.') };
  const b = d.best || {}, s = Math.min(b.width || 0, b.height || 0);
  const verdict = !d.best ? '❌ TikTok did not list any quality variants.' : s >= 1080 ? `✅ TikTok serves this in **${label(b.width, b.height)}**. HD kept.` : s >= 720 ? `⚠️ Only **${s}p**. Re-export at 1080p, run the Method and upload from a computer.` : `❌ Low quality (**${s}p**). Upload the original file from a computer with Upload HD on.`;
  return { embeds: [{
    color: ORANGE, author: { name: '@' + (d.author?.username || '?'), url: d.url }, title: (d.desc || 'TikTok video').slice(0, 200), url: d.url,
    thumbnail: d.cover ? { url: d.cover } : undefined, description: verdict,
    fields: [
      { name: '👀 Views', value: short(d.stats?.views), inline: true },
      { name: '❤️ Likes', value: short(d.stats?.likes), inline: true },
      { name: '💬 Comments', value: short(d.stats?.comments), inline: true },
      { name: '🔁 Shares', value: short(d.stats?.shares), inline: true },
      { name: '🔖 Saves', value: short(d.stats?.saves), inline: true },
      { name: '🎞️ Best quality', value: `${label(b.width, b.height)}${b.codec ? ' · ' + b.codec : ''}${b.fps ? ' · ' + b.fps + ' FPS' : ''}${b.bitrateKbps ? ' · ' + (b.bitrateKbps / 1000).toFixed(1) + ' Mbps' : ''}`, inline: true }
    ], footer: FOOT }] };
}

/* ---------------- edit rating ---------------- */
const rateButtons = () => [1, 6].map(start => ({ type: 1, components: [0, 1, 2, 3, 4].map(k => ({ type: 2, style: 2, label: String(start + k), custom_id: 'rate:' + (start + k) })) }));
const scoreText = (avg, n) => n ? `**${avg.toFixed(1)} / 10** · ${n} vote${n === 1 ? '' : 's'}` : 'No votes yet. Be the first!';
function rateStart(i) {
  const by = i.member?.user || i.user || {};
  let link = '', who = '';
  if (i.data.type === 3) {
    const m = i.data.resolved?.messages?.[i.data.target_id];
    if (!m) return secret('Could not find that message.');
    if (!(m.attachments || []).length && !/https?:\/\//.test(m.content || '')) return secret('That message has no video or link to rate.');
    link = `https://discord.com/channels/${i.guild_id}/${m.channel_id}/${m.id}`;
    who = m.author ? `<@${m.author.id}>` : 'this';
  } else {
    link = String(opt(i, 'link') || '').trim();
    if (!/^https?:\/\/\S+$/i.test(link)) return secret('Paste a link to the edit (TikTok, YouTube, Discord message…).');
    who = `<@${by.id}>`;
  }
  return reply({ content: `🎬 Rate ${who}'s edit! ${link}`,
    embeds: [{ color: ORANGE, title: 'Rate this edit 1–10', description: 'Click a number below. You can change your vote anytime.', fields: [{ name: '⭐ Score', value: scoreText(0, 0) }], footer: FOOT }],
    components: rateButtons(), allowed_mentions: { parse: [] } });
}
async function rateVote(i, env) {
  const score = Number(String(i.data.custom_id).split(':')[1]);
  const uid = i.member?.user?.id || i.user?.id;
  if (!(score >= 1 && score <= 10) || !uid) return secret('Invalid vote.');
  let votes = {};
  try {
    votes = (await env.VOTES.get('rate:' + i.message.id, 'json')) || {};
    votes[uid] = score;
    await env.VOTES.put('rate:' + i.message.id, JSON.stringify(votes), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { return secret('❌ Could not save your vote. Try again in a moment.'); }
  const vals = Object.values(votes), n = vals.length, avg = vals.reduce((a, b) => a + b, 0) / n;
  const embed = { ...(i.message.embeds?.[0] || { color: ORANGE, title: 'Rate this edit 1–10' }) };
  embed.fields = [{ name: '⭐ Score', value: scoreText(avg, n) }];
  return json({ type: 7, data: { embeds: [embed], components: rateButtons() } });
}

/* ---------------- role picker ---------------- */
const PICK_ROLES = [
  { name: 'CapCut', color: 0x2b2b2b, emoji: '✂️' }, { name: 'After Effects', color: 0x9999ff, emoji: '🟣' },
  { name: 'Alight Motion', color: 0x3ddc84, emoji: '🟢' }, { name: 'Premiere Pro', color: 0x7b68ee, emoji: '🎞️' },
  { name: 'Video Star', color: 0xffc83d, emoji: '⭐' }, { name: 'Vegas Pro', color: 0x4fa3ff, emoji: '🔵' }
];
async function rolesPost(i, env) {
  const call = bot(env), gid = i.guild_id;
  try {
    const existing = await call(`/guilds/${gid}/roles`), ids = [];
    for (const r of PICK_ROLES) {
      let role = existing.find(x => x.name.toLowerCase() === r.name.toLowerCase());
      if (!role) role = await call(`/guilds/${gid}/roles`, 'POST', { name: r.name, color: r.color, mentionable: false, permissions: '0' });
      ids.push(role.id);
    }
    const buttons = PICK_ROLES.map((r, k) => ({ type: 2, style: 2, label: r.name, emoji: { name: r.emoji }, custom_id: 'role:' + ids[k] }));
    return reply({ embeds: [{ color: ORANGE, title: '🎨 What do you edit with?', description: 'Click to get a role for your editing app. Click again to remove it. You can pick more than one.' }],
      components: [{ type: 1, components: buttons.slice(0, 3) }, { type: 1, components: buttons.slice(3) }] });
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? '❌ I need the **Manage Roles** permission. Server Settings → Roles → FrameUp → turn on Manage Roles.' : '❌ Discord error: ' + e.message);
  }
}
async function roleToggle(i, env) {
  const call = bot(env), gid = i.guild_id, uid = i.member?.user?.id, rid = String(i.data.custom_id).split(':')[1];
  if (!gid || !uid || !/^\d+$/.test(rid)) return secret('Invalid button.');
  try {
    const role = (await call(`/guilds/${gid}/roles`)).find(r => r.id === rid);
    if (!role || !PICK_ROLES.some(p => p.name.toLowerCase() === role.name.toLowerCase())) return secret('This role is not available anymore.');
    const has = (i.member.roles || []).includes(rid);
    await call(`/guilds/${gid}/members/${uid}/roles/${rid}`, has ? 'DELETE' : 'PUT');
    return secret(has ? `Removed **${role.name}**.` : `✅ You now have **${role.name}**.`);
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? "❌ I can't give that role. Move the FrameUp role above the editing app roles in Server Settings → Roles." : '❌ Discord error: ' + e.message);
  }
}

/* ---------------- export settings ---------------- */
const TIP = 'Then run the file through the **FrameUp Method** (frameupmethod.github.io) and upload from a computer with Upload HD on.';
const SETTINGS = {
  capcut: { title: 'CapCut → TikTok', lines: ['**Resolution:** 1080p (2K/4K only if your clips are that sharp)', '**Frame rate:** same as your project (30 or 60)', '**Bitrate / Code rate:** Higher, or Custom at the max', '**Format:** MP4', '**Smart HDR:** off', '**Optical flow / slow-mo:** render it in the project, not on export'] },
  ae: { title: 'After Effects → TikTok', lines: ['Export with **Media Encoder** (File → Export → Add to Media Encoder Queue)', '**Format:** H.264 · **Preset:** Match Source – High bitrate', '**Size:** 1080×1920 · **Frame rate:** same as comp', '**Bitrate:** VBR 2 pass · Target 30 Mbps · Max 50 Mbps', '**Render at Maximum Depth** + **Use Maximum Render Quality**: on', '**Audio:** AAC · 48 kHz · 320 kbps'] },
  premiere: { title: 'Premiere Pro → TikTok', lines: ['**Format:** H.264 · **Preset:** Match Source – High bitrate', '**Size:** 1080×1920 · **Frame rate:** same as sequence', '**Bitrate:** VBR 2 pass · Target 30 Mbps · Max 50 Mbps', '**Use Maximum Render Quality**: on', '**Audio:** AAC · 48 kHz · 320 kbps'] },
  alight: { title: 'Alight Motion → TikTok', lines: ['Export → **Video**', '**Resolution:** 1080p', '**Frame rate:** same as project (30 or 60)', '**Quality:** 100%', '**Format:** MP4'] }
};
function settingsReply(i) {
  const s = SETTINGS[String(opt(i, 'app') || 'capcut')] || SETTINGS.capcut;
  return reply({ embeds: [{ color: ORANGE, title: '⚙️ ' + s.title, description: s.lines.map(l => '• ' + l).join('\n') + '\n\n' + TIP, footer: { text: 'FrameUp · best TikTok export settings' } }] });
}

/* ---------------- announcements ---------------- */
function announceModal(i) {
  if (!canManage(i)) return secret('Only server managers can post announcements.');
  const field = (id, lbl, style, max, required) => ({ type: 1, components: [{ type: 4, custom_id: id, label: lbl, style, max_length: max, required }] });
  return json({ type: 9, data: { custom_id: 'announce:' + (opt(i, 'ping') ? 1 : 0), title: 'New announcement',
    components: [field('title', 'Title (optional)', 1, 200, false), field('body', 'Message', 2, 3800, true), field('image', 'Image link (optional)', 1, 500, false)] } });
}
async function announceSubmit(i, env) {
  if (!canManage(i)) return secret('Only server managers can post announcements.');
  const channel = env.DISCORD_ANNOUNCE_CHANNEL;
  if (!channel) return secret('Announcements channel is not set up.');
  const val = id => { for (const row of i.data.components || []) for (const c of row.components || []) if (c.custom_id === id) return String(c.value || '').trim(); return ''; };
  const title = val('title'), body = val('body'), image = val('image'), ping = String(i.data.custom_id).endsWith(':1');
  const embed = { color: ORANGE, description: body, footer: FOOT, timestamp: new Date().toISOString() };
  if (title) embed.title = title;
  if (/^https:\/\/\S+$/i.test(image)) embed.image = { url: image };
  try {
    await bot(env)(`/channels/${channel}/messages`, 'POST', { content: ping ? '@everyone' : undefined, embeds: [embed], allowed_mentions: { parse: ping ? ['everyone'] : [] } });
    return secret(`✅ Posted in <#${channel}>.`);
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? "❌ I can't post there. Give the FrameUp role Send Messages (and Mention Everyone for pings) in #announcements." : '❌ Discord error: ' + e.message);
  }
}

/* ---------------- moderation ---------------- */
async function moderate(i, env) {
  const call = bot(env), name = i.data.name, gid = i.guild_id;
  if (!gid) return secret('This command only works in a server.');
  const uid = opt(i, 'user'), reason = opt(i, 'reason') || 'No reason given';
  const target = i.data.resolved?.users?.[uid];
  const tag = target ? `**${target.global_name || target.username}**` : `<@${uid}>`;
  const by = i.member?.user?.username || 'a moderator';
  if (uid === i.member?.user?.id) return secret("You can't use this on yourself.");
  try {
    if (name === 'kick') { await call(`/guilds/${gid}/members/${uid}`, 'DELETE', null, `${reason} (by ${by})`); return reply({ content: `👢 ${tag} was kicked. Reason: ${reason}` }); }
    if (name === 'ban') {
      const days = Math.min(7, Math.max(0, Number(opt(i, 'delete_days') || 0)));
      await call(`/guilds/${gid}/bans/${uid}`, 'PUT', { delete_message_seconds: days * 86400 }, `${reason} (by ${by})`);
      return reply({ content: `🔨 ${tag} was banned. Reason: ${reason}` });
    }
    if (name === 'timeout') {
      const mins = Math.min(40320, Math.max(0, Number(opt(i, 'minutes') ?? 10)));
      await call(`/guilds/${gid}/members/${uid}`, 'PATCH', { communication_disabled_until: mins ? new Date(Date.now() + mins * 60000).toISOString() : null }, `${reason} (by ${by})`);
      return reply({ content: mins ? `🔇 ${tag} is muted for ${mins} min. Reason: ${reason}` : `🔊 ${tag} can talk again.` });
    }
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? "❌ I can't do that. Move the **FrameUp** bot role above that member's roles in Server Settings → Roles, and make sure it has the permission." : '❌ Discord error: ' + e.message);
  }
  return secret('Unknown command.');
}

/* ---------------- router ---------------- */
async function interaction(i, env, ctx) {
  if (i.type === 1) return json({ type: 1 });
  if (i.type === 3) {
    const cid = String(i.data.custom_id || '');
    if (cid.startsWith('rate:')) return rateVote(i, env);
    if (cid.startsWith('role:')) return roleToggle(i, env);
    return secret('Unknown button.');
  }
  if (i.type === 5 && String(i.data.custom_id || '').startsWith('announce')) return announceSubmit(i, env);
  if (i.type !== 2) return secret('Unsupported.');
  const name = i.data.name;
  if (name === 'website') return reply({
    embeds: [{ color: ORANGE, title: '🎬 FrameUp – the best TikTok quality method', url: SITE,
      description: 'Drop your edit, press one button, get **1080p 60 FPS** tuned for TikTok. Free, runs in your browser.\n\nAlso check any TikTok: views, likes and the quality TikTok serves.', footer: { text: 'frameupmethod.github.io' } }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open FrameUp', url: SITE }] }] });
  if (name === 'rate' || name === 'Rate this edit') return rateStart(i);
  if (name === 'settings') return settingsReply(i);
  if (name === 'roles') return canManage(i) ? rolesPost(i, env) : secret('Only server managers can post the role picker.');
  if (name === 'announce') return announceModal(i);
  if (name === 'check') {
    const url = String(opt(i, 'link') || '').trim();
    if (!/^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) return secret('Paste a TikTok video link, e.g. https://www.tiktok.com/@you/video/123…');
    ctx.waitUntil((async () => {
      let data;
      try { data = await checkEmbed(url); } catch { data = { content: '❌ Check failed. Try again in a moment.' }; }
      await fetch(`${API}/webhooks/${i.application_id}/${i.token}/messages/@original`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    })());
    return reply({}, 5);
  }
  return moderate(i, env);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/check') {
      const cors = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' };
      const { status, body } = await tiktokCheck(url.searchParams.get('url') || '');
      return json(body, status, cors);
    }
    if (url.pathname === '/register') {
      if (!env.DISCORD_TOKEN || !env.DISCORD_APP_ID) return json({ error: 'missing DISCORD_TOKEN or DISCORD_APP_ID' }, 500);
      const r = await fetch(`${API}/applications/${env.DISCORD_APP_ID}/commands`, { method: 'PUT', headers: { authorization: 'Bot ' + env.DISCORD_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(COMMANDS) });
      const out = await r.json().catch(() => ({}));
      return json({ status: r.status, commands: Array.isArray(out) ? out.map(c => c.name) : out });
    }
    if (req.method !== 'POST') return new Response('FrameUp bot is online.');
    const body = await req.text();
    const ok = env.DISCORD_PUBLIC_KEY && await validSignature(body, req.headers.get('x-signature-ed25519') || '', req.headers.get('x-signature-timestamp') || '', env.DISCORD_PUBLIC_KEY);
    if (!ok) return new Response('bad signature', { status: 401 });
    return interaction(JSON.parse(body), env, ctx);
  }
};
