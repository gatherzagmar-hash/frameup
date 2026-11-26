// FrameUp Discord bot: slash commands over HTTP (Discord Interactions).
// Env vars (Netlify): DISCORD_PUBLIC_KEY, DISCORD_TOKEN.
import { createPublicKey, verify } from 'node:crypto';
import { rateStart, rateVote, rolesPost, roleToggle, settingsReply } from '../shared/features.mjs';

const API = 'https://discord.com/api/v10';
const ORANGE = 0xff4d1a;
const SITE = process.env.URL || 'https://frameup-pl.netlify.app';

const reply = (data, type = 4) => new Response(JSON.stringify({ type, data }), { headers: { 'content-type': 'application/json' } });
const secret = text => reply({ content: text, flags: 64 });

function validSignature(body, sig, ts, hexKey) {
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hexKey, 'hex')]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(ts + body), key, Buffer.from(sig, 'hex'));
  } catch { return false; }
}

async function discord(path, method, body, reason) {
  const headers = { authorization: 'Bot ' + process.env.DISCORD_TOKEN, 'content-type': 'application/json' };
  if (reason) headers['x-audit-log-reason'] = encodeURIComponent(reason.slice(0, 400));
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} throw new Error(r.status + (m ? ' ' + m : '')); }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const short = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n);
const label = (w, h) => { if (!w || !h) return '–'; const s = Math.min(w, h); return s >= 2160 ? '4K' : s >= 1440 ? '2K' : s + 'p'; };

export async function checkEmbed(url) {
  const r = await fetch(SITE + '/api/check?url=' + encodeURIComponent(url));
  const d = await r.json().catch(() => ({ error: 'Check failed.' }));
  if (!r.ok) return { content: '❌ ' + (d.error || 'Check failed.') };
  const b = d.best || {}, s = Math.min(b.width || 0, b.height || 0);
  const verdict = !d.best ? '❌ TikTok did not list any quality variants.' : s >= 1080 ? `✅ TikTok serves this in **${label(b.width, b.height)}**. HD kept.` : s >= 720 ? `⚠️ Only **${s}p**. Re-export at 1080p, run the Method and upload from a computer.` : `❌ Low quality (**${s}p**). Upload the original file from a computer with Upload HD on.`;
  return {
    embeds: [{
      color: ORANGE,
      author: { name: '@' + (d.author?.username || '?'), url: d.url },
      title: (d.desc || 'TikTok video').slice(0, 200),
      url: d.url,
      thumbnail: d.cover ? { url: d.cover } : undefined,
      description: verdict,
      fields: [
        { name: '👀 Views', value: short(d.stats?.views), inline: true },
        { name: '❤️ Likes', value: short(d.stats?.likes), inline: true },
        { name: '💬 Comments', value: short(d.stats?.comments), inline: true },
        { name: '🔁 Shares', value: short(d.stats?.shares), inline: true },
        { name: '🔖 Saves', value: short(d.stats?.saves), inline: true },
        { name: '🎞️ Best quality', value: `${label(b.width, b.height)}${b.codec ? ' · ' + b.codec : ''}${b.bitrateKbps ? ' · ' + (b.bitrateKbps / 1000).toFixed(1) + ' Mbps' : ''}`, inline: true }
      ],
      footer: { text: 'FrameUp · frameup-pl.netlify.app' }
    }]
  };
}

const opt = (i, name) => (i.data.options || []).find(o => o.name === name)?.value;

async function moderate(i) {
  const name = i.data.name, gid = i.guild_id;
  if (!gid) return secret('This command only works in a server.');
  const uid = opt(i, 'user'), reason = opt(i, 'reason') || 'No reason given';
  const target = i.data.resolved?.users?.[uid];
  const tag = target ? `**${target.global_name || target.username}**` : `<@${uid}>`;
  const by = i.member?.user?.username || 'a moderator';
  if (uid === i.member?.user?.id) return secret("You can't use this on yourself.");
  try {
    if (name === 'kick') {
      await discord(`/guilds/${gid}/members/${uid}`, 'DELETE', null, `${reason} (by ${by})`);
      return reply({ content: `👢 ${tag} was kicked. Reason: ${reason}` });
    }
    if (name === 'ban') {
      const days = Math.min(7, Math.max(0, Number(opt(i, 'delete_days') || 0)));
      await discord(`/guilds/${gid}/bans/${uid}`, 'PUT', { delete_message_seconds: days * 86400 }, `${reason} (by ${by})`);
      return reply({ content: `🔨 ${tag} was banned. Reason: ${reason}` });
    }
    if (name === 'timeout') {
      const mins = Math.min(40320, Math.max(0, Number(opt(i, 'minutes') ?? 10)));
      const until = mins ? new Date(Date.now() + mins * 60000).toISOString() : null;
      await discord(`/guilds/${gid}/members/${uid}`, 'PATCH', { communication_disabled_until: until }, `${reason} (by ${by})`);
      return reply({ content: mins ? `🔇 ${tag} is muted for ${mins} min. Reason: ${reason}` : `🔊 ${tag} can talk again.` });
    }
  } catch (e) {
    const m = String(e.message || e);
    return secret(/^403/.test(m) ? "❌ I can't do that. Move the **FrameUp** bot role above that member's roles in Server Settings → Roles, and make sure it has the permission." : '❌ Discord error: ' + m);
  }
  return secret('Unknown command.');
}

const canManage = i => { try { return (BigInt(i.member?.permissions || 0) & 0x28n) !== 0n; } catch { return false; } }; // MANAGE_GUILD or ADMINISTRATOR

async function announce(i) {
  if (!canManage(i)) return secret('Only server managers can post announcements.');
  const channel = process.env.DISCORD_ANNOUNCE_CHANNEL;
  if (!channel) return secret('Announcements channel is not set up.');
  const val = id => { for (const row of i.data.components || []) for (const c of row.components || []) if (c.custom_id === id) return String(c.value || '').trim(); return ''; };
  const title = val('title'), body = val('body'), image = val('image');
  const ping = String(i.data.custom_id).endsWith(':1');
  const embed = { color: ORANGE, description: body, footer: { text: 'FrameUp · frameup-pl.netlify.app' }, timestamp: new Date().toISOString() };
  if (title) embed.title = title;
  if (/^https:\/\/\S+$/i.test(image)) embed.image = { url: image };
  try {
    await discord(`/channels/${channel}/messages`, 'POST', { content: ping ? '@everyone' : undefined, embeds: [embed], allowed_mentions: { parse: ping ? ['everyone'] : [] } });
    return secret(`✅ Posted in <#${channel}>.`);
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? "❌ I can't post there. Give the FrameUp role Send Messages (and Mention Everyone for pings) in #announcements." : '❌ Discord error: ' + e.message);
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('FrameUp bot is online.', { status: 200 });
  const body = await req.text();
  const sig = req.headers.get('x-signature-ed25519') || '', ts = req.headers.get('x-signature-timestamp') || '';
  if (!process.env.DISCORD_PUBLIC_KEY || !validSignature(body, sig, ts, process.env.DISCORD_PUBLIC_KEY)) return new Response('bad signature', { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) return new Response(JSON.stringify({ type: 1 }), { headers: { 'content-type': 'application/json' } });
  if (i.type === 5 && String(i.data.custom_id || '').startsWith('announce')) return announce(i);
  if (i.type === 3) {
    const cid = String(i.data.custom_id || '');
    if (cid.startsWith('rate:')) return rateVote(i);
    if (cid.startsWith('role:')) return roleToggle(i);
    return secret('Unknown button.');
  }
  if (i.type !== 2) return secret('Unsupported.');
  if (i.data.name === 'rate' || i.data.name === 'Rate this edit') return rateStart(i);
  if (i.data.name === 'settings') return settingsReply(i);
  if (i.data.name === 'roles') return canManage(i) ? rolesPost(i) : secret('Only server managers can post the role picker.');

  if (i.data.name === 'announce') {
    if (!canManage(i)) return secret('Only server managers can post announcements.');
    const ping = opt(i, 'ping') ? 1 : 0;
    const field = (id, label, style, max, required) => ({ type: 1, components: [{ type: 4, custom_id: id, label, style, max_length: max, required }] });
    return new Response(JSON.stringify({ type: 9, data: {
      custom_id: 'announce:' + ping, title: 'New announcement',
      components: [field('title', 'Title (optional)', 1, 200, false), field('body', 'Message', 2, 3800, true), field('image', 'Image link (optional)', 1, 500, false)]
    } }), { headers: { 'content-type': 'application/json' } });
  }

  if (i.data.name === 'check') {
    const url = String(opt(i, 'link') || '').trim();
    if (!/^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) return secret('Paste a TikTok video link, e.g. https://www.tiktok.com/@you/video/123…');
    const followUp = async () => {
      let data;
      try { data = await checkEmbed(url); } catch { data = { content: '❌ Check failed. Try again in a moment.' }; }
      await fetch(`${API}/webhooks/${i.application_id}/${i.token}/messages/@original`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    };
    if (context && typeof context.waitUntil === 'function') { context.waitUntil(followUp()); return reply({}, 5); }
    try { return reply(await Promise.race([checkEmbed(url), new Promise((_, r) => setTimeout(() => r(new Error('slow')), 2700))])); }
    catch { return secret('⏳ TikTok is slow right now. Try again in a moment.'); }
  }
  return moderate(i);
};

export const config = { path: '/api/discord' };
