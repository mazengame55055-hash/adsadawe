const { Client } = require('discord.js-selfbot-v13');
const { Streamer, playStream } = require('@dank074/discord-video-stream');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const { Readable } = require('stream');

const client = new Client({
    intents: 33281,
});
const streamer = new Streamer(client);

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1483113341160259806';
const VOICE_ID = '1483120294917963891';
const OWNER_ID = '820408813790167041';

const IPTV = {
    host: 'http://ugeen.live',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    ultra: { width: 480, height: 270, fps: 10, vb: '200k', maxrate: '300k', bufsize: '300k' },
    low: { width: 640, height: 360, fps: 15, vb: '400k', maxrate: '600k', bufsize: '600k' },
    medium: { width: 854, height: 480, fps: 20, vb: '800k', maxrate: '1000k', bufsize: '1000k' },
    high: { width: 1280, height: 720, fps: 25, vb: '1200k', maxrate: '1500k', bufsize: '1500k' },
};

let selectedQuality = QUALITY_PRESETS.ultra;
let currentChannelName = null;
let abortController = null;
let channelsCache = null;
let isPlaying = false;
let ffmpegProcess = null;

function findFfmpeg() {
    const paths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
    for (const p of paths) { if (fs.existsSync(p)) return p; }
    try {
        const r = execSync('which ffmpeg', { encoding: 'utf-8', timeout: 3000 });
        if (r) return r.trim();
    } catch (_) {}
    try {
        const r = execSync('where ffmpeg', { encoding: 'utf-8', timeout: 3000 });
        if (r) return r.trim().split('\n')[0];
    } catch (_) {}
    return null;
}
const ffmpegPath = findFfmpeg();

async function sendMsg(channelId, content) {
    const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    if (!res.ok) console.error(`sendMsg HTTP ${res.status}`);
}

function parseM3U(m3uText) {
    const channels = {};
    const lines = m3uText.split('\n');
    let index = 1;
    let currentName = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
            const nameMatch = trimmed.match(/tvg-name="([^"]*)"/) || trimmed.match(/,([^,]+)$/);
            if (nameMatch) { currentName = nameMatch[1].trim(); }
        } else if (trimmed.startsWith('http') && currentName) {
            channels[String(index)] = { name: currentName, url: trimmed };
            index++; currentName = null;
        }
    }
    return channels;
}

async function fetchChannels() {
    try {
        const response = await fetch(M3U_URL);
        channelsCache = parseM3U(await response.text());
        console.log(`Fetched ${Object.keys(channelsCache).length} channels`);
        return channelsCache;
    } catch (err) {
        console.error('Failed to fetch M3U:', err.message);
        return channelsCache || null;
    }
}

const PAGE_SIZE = 30;

async function showChannelsPage(message, channels, page) {
    const entries = Object.entries(channels);
    const totalPages = Math.ceil(entries.length / PAGE_SIZE);
    const p = Math.max(1, Math.min(page, totalPages));
    const start = (p - 1) * PAGE_SIZE;
    const list = entries.slice(start, start + PAGE_SIZE)
        .map(([k, ch]) => `\`${String(k).padStart(3)}\` ${ch.name}`).join('\n');
    await sendMsg(message.channelId, [
        `📺 **الصفحة ${p}/${totalPages} (${entries.length} قناة)**`, '',
        list, '',
        p > 1 ? `🔹 \`!tv ${p - 1}\` → السابقة` : '',
        p < totalPages ? `🔹 \`!tv ${p + 1}\` → التالية` : '',
        '🔹 \`!play <رقم>\` للتشغيل', '🔹 \`!stop\` للإيقاف',
    ].filter(Boolean).join('\n'));
}

async function stopPlaying(message) {
    if (ffmpegProcess) { ffmpegProcess.kill('SIGKILL'); ffmpegProcess = null; }
    if (abortController) { abortController.abort(); abortController = null; }
    streamer.stopStream(); streamer.leaveVoice();
    const name = currentChannelName; currentChannelName = null; isPlaying = false;
    if (message) await sendMsg(message.channelId, `🛑 تم إيقاف ${name ? `**${name}**` : 'البث'}.`);
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    if (ffmpegPath) console.log(`FFmpeg: ${ffmpegPath}`);
    else console.log('FFmpeg not found, using direct mode');
    await fetchChannels();
});

client.on('messageCreate', async (message) => {
    if (message.author.id !== OWNER_ID) return;
    console.log(`Got message: ${message.content}`);
    try {
        const c = message.content;

        if (c === '!ping') return await sendMsg(message.channelId, 'pong');

        if (c === '!tv' || /^!tv \d+$/.test(c)) {
            const channels = await fetchChannels();
            if (!channels || !Object.keys(channels).length) return sendMsg(message.channelId, '❌ لا توجد قنوات.');
            const page = c === '!tv' ? 1 : parseInt(c.split(' ')[1], 10);
            return await showChannelsPage(message, channels, page);
        }

        if (c.startsWith('!quality ')) {
            const preset = c.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) return sendMsg(message.channelId, '❌ ultra, low, medium, high');
            selectedQuality = QUALITY_PRESETS[preset];
            return await sendMsg(message.channelId, `✅ ${preset} (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (c.startsWith('!play ')) {
            if (isPlaying) return sendMsg(message.channelId, '❌ يوجد بث. استعمل !stop أولاً.');
            const channels = await fetchChannels();
            if (!channels) return sendMsg(message.channelId, '❌ تعذر جلب القنوات.');
            const chKey = c.split(' ')[1];
            console.log(`Looking for channel key: "${chKey}"`);
            const channel = channels[chKey];
            if (!channel) {
                console.log(`Channel not found. Available keys sample: ${Object.keys(channels).slice(0,5).join(', ')}`);
                return sendMsg(message.channelId, `❌ القناة غير موجودة. اكتب !tv.`);
            }
            console.log(`Found channel: ${channel.name}, url: ${channel.url.substring(0,50)}...`);

            abortController = new AbortController();
            currentChannelName = channel.name; isPlaying = true;
            console.log('Sending status message...');
            await sendMsg(message.channelId, `⏳ **${channel.name}**...`);
            console.log('Status sent, joining voice...');
            await streamer.joinVoice(GUILD_ID, VOICE_ID);
            console.log(`Starting: ${channel.name}`);

            const response = await fetch(channel.url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: abortController.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            try { if (fs.existsSync(ffmpegPath)) fs.chmodSync(ffmpegPath, 0o777); } catch (_) {}

            ffmpegProcess = spawn(ffmpegPath, [
                '-analyzeduration', '500000', '-probesize', '500000',
                '-f', 'mpegts', '-i', 'pipe:0',
                '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-b:v', selectedQuality.vb, '-maxrate', selectedQuality.maxrate,
                '-bufsize', selectedQuality.bufsize, '-crf', '35',
                '-r', String(selectedQuality.fps), '-vsync', 'cfr',
                '-c:a', 'libopus', '-b:a', '48k', '-ac', '1',
                '-f', 'mpegts', '-flags', '+low_delay', '-fflags', 'nobuffer',
                '-threads', '1', '-muxdelay', '0', '-muxpreload', '0',
                'pipe:1',
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            ffmpegProcess.stdin.on('error', () => {});
            const input = Readable.fromWeb(response.body);
            input.on('error', () => {});
            input.pipe(ffmpegProcess.stdin);
            ffmpegProcess.on('exit', (code) => { console.log(`FFmpeg exit ${code}`); ffmpegProcess = null; });
            abortController.signal.addEventListener('abort', () => { if (ffmpegProcess) ffmpegProcess.kill('SIGKILL'); });

            await playStream(ffmpegProcess.stdout, streamer, {
                type: 'go-live', format: 'mpegts',
                width: selectedQuality.width, height: selectedQuality.height, frameRate: selectedQuality.fps,
            });
            isPlaying = false;
            return await sendMsg(message.channelId, `🎥 **${channel.name}** انتهى.`);
        }

        if (c === '!stop') return await stopPlaying(message);
        if (c === '!help') return await sendMsg(message.channelId, [
            '🤖 **الأوامر:**', '', '!tv - القنوات', '!play <رقم> - تشغيل',
            '!stop - إيقاف', '!quality <ultra|low|medium|high> - الجودة', '!status - الحالة', '!help - المساعدة',
        ].join('\n'));
        if (c === '!status') return await sendMsg(message.channelId, 
            (isPlaying ? `🎥 **يشتغل:** ${currentChannelName || 'قناة'}` : '🛑 **متوقف**') +
            `\n📐 ${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`
        );

    } catch (err) {
        if (err.name === 'AbortError') { isPlaying = false; return; }
        console.error(err.message);
        isPlaying = false;
        try { await sendMsg(message.channelId, `❌ ${err.message}`); } catch (_) {}
        if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null; streamer.stopStream(); streamer.leaveVoice();
    }
});

client.login(TOKEN);
