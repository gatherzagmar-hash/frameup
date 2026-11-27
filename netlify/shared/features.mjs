// FrameUp bot extras: edit rating, role picker, export settings.
import { getStore } from '@netlify/blobs';

const API = 'https://discord.com/api/v10';
const ORANGE = 0xff4d1a;
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const secret = content => json({ type: 4, data: { content, flags: 64 } });
const bot = async (path, method = 'GET', body) => {
  const r = await fetch(API + path, { method, headers: { authorization: 'Bot ' + process.env.DISCORD_TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} throw new Error(r.status + (m ? ' ' + m : '')); }
  return r.status === 204 ? null : r.json().catch(() => null);
};

/* ---------- 1. Edit rating ---------- */
const rateButtons = () => [1, 6].map(start => ({
  type: 1, components: [0, 1, 2, 3, 4].map(k => ({ type: 2, style: 2, label: String(start + k), custom_id: 'rate:' + (start + k) }))
}));
const scoreText = (avg, n) => n ? `**${avg.toFixed(1)} / 10** · ${n} vote${n === 1 ? '' : 's'}` : 'No votes yet. Be the first!';

export function rateStart(i) {
  const by = i.member?.user || i.user || {};
  let link = '', who = '';
  if (i.data.type === 3) { // right-click a message → Apps → Rate this edit
    const m = i.data.resolved?.messages?.[i.data.target_id];
    if (!m) return secret('Could not find that message.');
    if (!(m.attachments || []).length && !/https?:\/\//.test(m.content || '')) return secret('That message has no video or link to rate.');
    link = `https://discord.com/channels/${i.guild_id}/${m.channel_id}/${m.id}`;
    who = m.author ? `<@${m.author.id}>` : 'this';
  } else {
    link = String((i.data.options || []).find(o => o.name === 'link')?.value || '').trim();
    if (!/^https?:\/\/\S+$/i.test(link)) return secret('Paste a link to the edit (TikTok, YouTube, Discord message…).');
    who = `<@${by.id}>`;
  }
  return json({ type: 4, data: {
    content: `🎬 Rate ${who}'s edit! ${link}`,
    embeds: [{ color: ORANGE, title: 'Rate this edit 1–10', description: 'Click a number below. You can change your vote anytime.', fields: [{ name: '⭐ Score', value: scoreText(0, 0) }], footer: { text: 'FrameUp · frameupmethod.github.io' } }],
    components: rateButtons(),
    allowed_mentions: { parse: [] }
  } });
}

export async function rateVote(i) {
  const score = Number(String(i.data.custom_id).split(':')[1]);
  const uid = i.member?.user?.id || i.user?.id;
  if (!(score >= 1 && score <= 10) || !uid) return secret('Invalid vote.');
  let votes = {};
  try {
    const store = getStore('edit-rates');
    votes = (await store.get(i.message.id, { type: 'json' })) || {};
    votes[uid] = score;
    await store.setJSON(i.message.id, votes);
  } catch (e) { return secret('❌ Could not save your vote. Try again in a moment.'); }
  const vals = Object.values(votes), n = vals.length, avg = vals.reduce((a, b) => a + b, 0) / n;
  const embed = { ...(i.message.embeds?.[0] || { color: ORANGE, title: 'Rate this edit 1–10' }) };
  embed.fields = [{ name: '⭐ Score', value: scoreText(avg, n) }];
  return json({ type: 7, data: { embeds: [embed], components: rateButtons() } });
}

/* ---------- 5. Role picker ---------- */
export const PICK_ROLES = [
  { name: 'CapCut', color: 0x2b2b2b, emoji: '✂️' },
  { name: 'After Effects', color: 0x9999ff, emoji: '🟣' },
  { name: 'Alight Motion', color: 0x3ddc84, emoji: '🟢' },
  { name: 'Premiere Pro', color: 0x7b68ee, emoji: '🎞️' },
  { name: 'Video Star', color: 0xffc83d, emoji: '⭐' },
  { name: 'Vegas Pro', color: 0x4fa3ff, emoji: '🔵' }
];

export async function rolesPost(i) {
  const gid = i.guild_id;
  try {
    const existing = await bot(`/guilds/${gid}/roles`);
    const ids = [];
    for (const r of PICK_ROLES) {
      let role = existing.find(x => x.name.toLowerCase() === r.name.toLowerCase());
      if (!role) role = await bot(`/guilds/${gid}/roles`, 'POST', { name: r.name, color: r.color, mentionable: false, permissions: '0' });
      ids.push(role.id);
    }
    const buttons = PICK_ROLES.map((r, k) => ({ type: 2, style: 2, label: r.name, emoji: { name: r.emoji }, custom_id: 'role:' + ids[k] }));
    return json({ type: 4, data: {
      embeds: [{ color: ORANGE, title: '🎨 What do you edit with?', description: 'Click to get a role for your editing app. Click again to remove it. You can pick more than one.' }],
      components: [{ type: 1, components: buttons.slice(0, 3) }, { type: 1, components: buttons.slice(3) }]
    } });
  } catch (e) {
    const m = String(e.message);
    return secret(/^403/.test(m) ? '❌ I need the **Manage Roles** permission. Server Settings → Roles → FrameUp → turn on Manage Roles.' : '❌ Discord error: ' + m);
  }
}

export async function roleToggle(i) {
  const gid = i.guild_id, uid = i.member?.user?.id, rid = String(i.data.custom_id).split(':')[1];
  if (!gid || !uid || !/^\d+$/.test(rid)) return secret('Invalid button.');
  try {
    const roles = await bot(`/guilds/${gid}/roles`);
    const role = roles.find(r => r.id === rid);
    if (!role || !PICK_ROLES.some(p => p.name.toLowerCase() === role.name.toLowerCase())) return secret('This role is not available anymore.');
    const has = (i.member.roles || []).includes(rid);
    await bot(`/guilds/${gid}/members/${uid}/roles/${rid}`, has ? 'DELETE' : 'PUT');
    return secret(has ? `Removed **${role.name}**.` : `✅ You now have **${role.name}**.`);
  } catch (e) {
    return secret(/^403/.test(String(e.message)) ? "❌ I can't give that role. Move the FrameUp role above the editing app roles in Server Settings → Roles." : '❌ Discord error: ' + e.message);
  }
}

/* ---------- 2. Export settings ---------- */
const TIP = 'Then run the file through the **FrameUp Method** (frameupmethod.github.io) and upload from a computer with Upload HD on.';
export const SETTINGS = {
  capcut: { title: 'CapCut → TikTok', lines: ['**Resolution:** 1080p (2K/4K only if your clips are that sharp)', '**Frame rate:** same as your project (30 or 60)', '**Bitrate / Code rate:** Higher, or Custom at the max', '**Format:** MP4', '**Smart HDR:** off', '**Optical flow / slow-mo:** render it in the project, not on export'] },
  ae: { title: 'After Effects → TikTok', lines: ['Export with **Media Encoder** (File → Export → Add to Media Encoder Queue)', '**Format:** H.264 · **Preset:** Match Source – High bitrate', '**Size:** 1080×1920 · **Frame rate:** same as comp', '**Bitrate:** VBR 2 pass · Target 30 Mbps · Max 50 Mbps', '**Render at Maximum Depth** + **Use Maximum Render Quality**: on', '**Audio:** AAC · 48 kHz · 320 kbps'] },
  premiere: { title: 'Premiere Pro → TikTok', lines: ['**Format:** H.264 · **Preset:** Match Source – High bitrate', '**Size:** 1080×1920 · **Frame rate:** same as sequence', '**Bitrate:** VBR 2 pass · Target 30 Mbps · Max 50 Mbps', '**Use Maximum Render Quality**: on', '**Audio:** AAC · 48 kHz · 320 kbps'] },
  alight: { title: 'Alight Motion → TikTok', lines: ['Export → **Video**', '**Resolution:** 1080p', '**Frame rate:** same as project (30 or 60)', '**Quality:** 100%', '**Format:** MP4'] }
};

export function settingsReply(i) {
  const app = String((i.data.options || []).find(o => o.name === 'app')?.value || 'capcut');
  const s = SETTINGS[app] || SETTINGS.capcut;
  return json({ type: 4, data: { embeds: [{ color: ORANGE, title: '⚙️ ' + s.title, description: s.lines.map(l => '• ' + l).join('\n') + '\n\n' + TIP, footer: { text: 'FrameUp · best TikTok export settings' } }] } });
}
