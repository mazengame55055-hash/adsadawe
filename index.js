const { Client } = require('discord.js-selfbot-v13');
const { Streamer, playStream } = require('@dank074/discord-video-stream');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

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
    ip: 'http://176.123.9.60',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.ip}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    ultra: { width: 480, height: 270, fps: 10, vb: '200k', maxrate: '300k', bufsize: '300k' },
    low: { width: 640, height: 360, fps: 15, vb: '400k', maxrate: '600k', bufsize: '600k' },
    medium: { width: 854, height: 480, fps: 20, vb: '800k', maxrate: '1000k', bufsize: '1000k' },
    high: { width: 1280, height: 720, fps: 25, vb: '1200k', maxrate: '1500k', bufsize: '1500k' },
};

let selectedQuality = QUALITY_PRESETS.ultra;
let directMode = false;
let currentChannelName = null;
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
            const url = trimmed.replace('ugeen.live', '176.123.9.60');
            channels[String(index)] = { name: currentName, url };
            index++; currentName = null;
        }
    }
    return channels;
}

async function fetchChannels() {
    if (channelsCache) return channelsCache;
    const urls = [
        M3U_URL,
        M3U_URL.replace('&output=ts', ''),
        `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u`,
    ];
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (!text.startsWith('#EXTM3U')) throw new Error('Not M3U');
            channelsCache = parseM3U(text);
            console.log(`Fetched ${Object.keys(channelsCache).length} channels`);
            return channelsCache;
        } catch (e) {
            console.error(`Failed with URL: ${url.slice(0, 80)}... ${e.message}`);
        }
    }
    if (channelsCache) return channelsCache;
    throw new Error('تعذر جلب القنوات من السيرفر');
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

async function playChannelSegmented(message, channel) {
    await streamer.joinVoice(GUILD_ID, VOICE_ID);
    const tmpDir = '/tmp/iptv';
    fs.mkdirSync(tmpDir, { recursive: true });

    const SEG = 60; // seconds per segment

    function produceSeg(num) {
        const outFile = `${tmpDir}/seg_${num}.ts`;
        const ffArgs = directMode ? [
            '-i', channel.url, '-t', String(SEG),
            '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '48k', '-ac', '1',
            '-f', 'mpegts', '-y', outFile,
        ] : [
            '-i', channel.url, '-t', String(SEG),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-b:v', selectedQuality.vb, '-maxrate', selectedQuality.maxrate,
            '-bufsize', selectedQuality.bufsize, '-crf', '35',
            '-r', String(selectedQuality.fps), '-vsync', 'cfr',
            '-c:a', 'libopus', '-b:a', '48k', '-ac', '1',
            '-f', 'mpegts', '-y', outFile,
        ];
        const proc = spawn(ffmpegPath, ffArgs);
        ffmpegProcess = proc;
        proc.stderr.on('data', () => {});
        const p = new Promise((resolve, reject) => {
            proc.on('exit', code => code === 0 ? resolve(outFile) : reject(new Error(`FFmpeg exit ${code}`)));
            proc.on('error', reject);
        });
        return { file: outFile, promise: p, proc };
    }

    let segNum = 0;

    // Produce first segment
    console.log(`Producing seg ${++segNum} (${SEG}s)...`);
    let current = produceSeg(segNum);
    let currentFile;
    try { currentFile = await current.promise; } catch (e) { if (!isPlaying) return; throw e; }
    if (!isPlaying) return;

    // Start producing next segment in background
    let next = produceSeg(++segNum);

    while (isPlaying) {
        // Play current
        const fileStream = fs.createReadStream(currentFile);
        await playStream(fileStream, streamer, {
            type: 'go-live', format: 'mpegts',
            width: selectedQuality.width, height: selectedQuality.height,
            frameRate: selectedQuality.fps,
        });
        if (!isPlaying) break;

        // Wait for next segment to be ready
        console.log('Waiting for next segment...');
        let nextFile;
        try { nextFile = await next.promise; } catch (e) { if (!isPlaying) break; throw e; }
        if (!isPlaying) break;

        // Cleanup old
        try { fs.unlinkSync(currentFile); } catch (_) {}

        // Swap
        currentFile = nextFile;
        next = produceSeg(++segNum);
    }

    currentChannelName = null; isPlaying = false; ffmpegProcess = null;
}

async function stopPlaying(message) {
    if (ffmpegProcess) { ffmpegProcess.kill('SIGKILL'); ffmpegProcess = null; }
    streamer.stopStream(); streamer.leaveVoice();
    const name = currentChannelName; currentChannelName = null; isPlaying = false;
    if (message) await sendMsg(message.channelId, `🛑 تم إيقاف ${name ? `**${name}**` : 'البث'}.`);
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    if (ffmpegPath) console.log(`FFmpeg: ${ffmpegPath}`);
    else console.log('FFmpeg not found, using direct mode');
    try { await fetchChannels(); } catch (_) {}
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

            currentChannelName = channel.name; isPlaying = true;
            console.log('Sending status message...');
            await sendMsg(message.channelId, `⏳ **${channel.name}**...`);
            console.log('Status sent, starting segment loop...');

            try {
                await playChannelSegmented(message, channel);
                await sendMsg(message.channelId, `🎥 **${channel.name}** انتهى.`);
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error('playChannelSegmented error:', err.message);
                isPlaying = false;
                streamer.stopStream(); streamer.leaveVoice();
                try { await sendMsg(message.channelId, `❌ ${err.message}`); } catch (_) {}
            }
            return;
        }

        if (c === '!direct') {
            directMode = !directMode;
            return await sendMsg(message.channelId, directMode ? '✅ **Direct mode** (نسخ الفيديو بدون إعادة تشفير)' : '✅ **Transcode mode** (إعادة تشفير)');
        }

        if (c === '!stop') return await stopPlaying(message);
        if (c === '!help') return await sendMsg(message.channelId, [
            '🤖 **الأوامر:**', '', '!tv - القنوات', '!play <رقم> - تشغيل',
            '!stop - إيقاف', '!direct - وضع مباشر (بدون إعادة تشفير)', '!quality <ultra|low|medium|high> - الجودة',
            '!status - الحالة', '!help - المساعدة',
        ].join('\n'));
        if (c === '!status') return await sendMsg(message.channelId, 
            (isPlaying ? `🎥 **يشتغل:** ${currentChannelName || 'قناة'}` : '🛑 **متوقف**') +
            `\n📐 ${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps` +
            `\n⚙️ ${directMode ? 'Direct (نسخ)' : 'Transcode (تشفير)'}`
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
