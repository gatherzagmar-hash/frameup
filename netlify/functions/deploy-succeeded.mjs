// Runs automatically after every successful Netlify deploy.
// 1) Registers the bot's slash commands.  2) Posts an update in #announcements.
// Env vars: DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_ANNOUNCE_CHANNEL (or DISCORD_ANNOUNCE_WEBHOOK).
// Put [skip] in the commit message to deploy without an announcement.

const API = 'https://discord.com/api/v10';
const KICK = String(1 << 1), BAN = String(1 << 2), MODERATE = String(1n << 40n);
const user = { name: 'user', description: 'Member', type: 6, required: true };
const reason = { name: 'reason', description: 'Reason (shown in the audit log)', type: 3, required: false, max_length: 300 };

export const COMMANDS = [
  { name: 'website', description: 'Get the link to the FrameUp website', dm_permission: false },
  { name: 'rate', description: 'Let people rate an edit 1-10', dm_permission: false,
    options: [{ name: 'link', description: 'Link to the edit (TikTok, YouTube, Discord message...)', type: 3, required: true }] },
  { name: 'Rate this edit', type: 3, dm_permission: false },
  { name: 'roles', description: 'Post the editing app role picker here', default_member_permissions: String(1 << 5), dm_permission: false },
  { name: 'settings', description: 'Best export settings for TikTok', dm_permission: false,
    options: [{ name: 'app', description: 'Your editing app', type: 3, required: true, choices: [
      { name: 'CapCut', value: 'capcut' }, { name: 'After Effects', value: 'ae' }, { name: 'Premiere Pro', value: 'premiere' }, { name: 'Alight Motion', value: 'alight' }] }] },
  { name: 'announce', description: 'Post an announcement in #announcements as FrameUp', default_member_permissions: String(1 << 5), dm_permission: false,
    options: [{ name: 'ping', description: 'Ping @everyone', type: 5, required: false }] },
  { name: 'check', description: 'Check a TikTok: views, likes and the quality TikTok serves', dm_permission: false,
    options: [{ name: 'link', description: 'TikTok video link', type: 3, required: true }] },
  { name: 'kick', description: 'Kick a member', default_member_permissions: KICK, dm_permission: false, options: [user, reason] },
  { name: 'ban', description: 'Ban a member', default_member_permissions: BAN, dm_permission: false,
    options: [user, reason, { name: 'delete_days', description: 'Delete their messages from the last N days (0-7)', type: 4, min_value: 0, max_value: 7, required: false }] },
  { name: 'timeout', description: 'Mute a member for some minutes (0 = unmute)', default_member_permissions: MODERATE, dm_permission: false,
    options: [user, { name: 'minutes', description: 'How long (default 10, max 40320 = 28 days)', type: 4, min_value: 0, max_value: 40320, required: false }, reason] }
];

export const handler = async (event) => {
  const out = [];
  const { DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_ANNOUNCE_WEBHOOK } = process.env;
  let deploy = {};
  try { deploy = JSON.parse(event.body || '{}').payload || {}; } catch {}

  if (DISCORD_TOKEN && DISCORD_APP_ID) {
    const r = await fetch(`${API}/applications/${DISCORD_APP_ID}/commands`, {
      method: 'PUT', headers: { authorization: 'Bot ' + DISCORD_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(COMMANDS)
    });
    out.push('commands ' + r.status);
  }

  if (DISCORD_TOKEN) {
    // Give the bot the FrameUp logo as its profile picture (only if it has none yet).
    try {
      const auth = { authorization: 'Bot ' + DISCORD_TOKEN, 'content-type': 'application/json' };
      const me = await (await fetch(`${API}/users/@me`, { headers: auth })).json();
      if (me && me.id && !me.avatar) {
        const html = await (await fetch(process.env.URL || 'https://frameup-pl.netlify.app')).text();
        const icon = (html.match(/rel="apple-touch-icon" href="(data:image\/png;base64,[^"]+)"/) || [])[1];
        if (icon) out.push('avatar ' + (await fetch(`${API}/users/@me`, { method: 'PATCH', headers: auth, body: JSON.stringify({ avatar: icon }) })).status);
      }
    } catch { out.push('avatar failed'); }
  }

  const title = String(deploy.title || '').trim();
  const prod = !deploy.context || deploy.context === 'production';
  const channel = process.env.DISCORD_ANNOUNCE_CHANNEL;
  if ((DISCORD_ANNOUNCE_WEBHOOK || (channel && DISCORD_TOKEN)) && prod && !/\[skip\]/i.test(title)) {
    const site = 'https://frameupmethod.github.io/';
    const embeds = [{
      color: 0xff4d1a,
      title: '🚀 FrameUp just got an update',
      description: (title ? `**${title.slice(0, 200)}**\n\n` : '') + `Try it now: ${site}`,
      url: site,
      timestamp: new Date().toISOString()
    }];
    const r = DISCORD_ANNOUNCE_WEBHOOK
      ? await fetch(DISCORD_ANNOUNCE_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'FrameUp', embeds }) })
      : await fetch(`${API}/channels/${channel}/messages`, { method: 'POST', headers: { authorization: 'Bot ' + DISCORD_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ embeds }) });
    out.push('announce ' + r.status);
  }
  return { statusCode: 200, body: out.join(', ') || 'nothing to do' };
};
