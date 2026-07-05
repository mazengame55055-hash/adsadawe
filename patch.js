const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, 'node_modules', '@dank074', 'discord-video-stream', 'dist', 'media', 'LibavDemuxer.js');

const content = `import pDebounce from "p-debounce";
import { BitStreamFilterAPI, Demuxer } from "node-av";
import { AVCodecID } from "./LibavCodecId.js";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";

const allowedVideoCodec = new Set([
    AVCodecID.AV_CODEC_ID_H264, AVCodecID.AV_CODEC_ID_H265,
    AVCodecID.AV_CODEC_ID_VP8, AVCodecID.AV_CODEC_ID_VP9, AVCodecID.AV_CODEC_ID_AV1,
]);
const allowedAudioCodec = new Set([AVCodecID.AV_CODEC_ID_OPUS]);

export async function demux(input, { format }) {
    const demuxer = await Demuxer.open(input, {
        options: { fflags: "nobuffer" }, format, bufferSize: 2048,
    });
    const vStream = demuxer.video();
    const aStream = demuxer.audio();
    let vInfo, aInfo;
    const vPipe = new PassThrough({ objectMode: true, writableHighWaterMark: 16 });
    const aPipe = new PassThrough({ objectMode: true, writableHighWaterMark: 8 });
    const vbsf = [];

    const cleanup = () => {
        input.destroy(); demuxer.close();
        vPipe.off("drain", readFrame); aPipe.off("drain", readFrame);
        vPipe.end(); aPipe.end();
        vbsf.forEach(e => e.close());
    };

    if (vStream) {
        const codecId = vStream.codecpar.codecId;
        if (!allowedVideoCodec.has(codecId)) { cleanup(); throw new Error("Video codec not allowed"); }
        try {
            switch (codecId) {
                case AVCodecID.AV_CODEC_ID_H264:
                    vbsf.push(BitStreamFilterAPI.create("h264_mp4toannexb", vStream));
                    vbsf.push(BitStreamFilterAPI.create("h264_metadata", vStream, { options: { aud: "remove" } }));
                    vbsf.push(BitStreamFilterAPI.create("dump_extra", vStream));
                    break;
                case AVCodecID.AV_CODEC_ID_HEVC:
                    vbsf.push(BitStreamFilterAPI.create("hevc_mp4toannexb", vStream));
                    vbsf.push(BitStreamFilterAPI.create("hevc_metadata", vStream, { options: { aud: "remove" } }));
                    vbsf.push(BitStreamFilterAPI.create("dump_extra", vStream));
                    break;
                default: vbsf.push(BitStreamFilterAPI.create("null", vStream));
            }
        } catch (e) { cleanup(); throw new Error("Failed to construct bitstream filterchain", { cause: e.cause }); }
        const codecpar = vbsf.at(-1)?.outputCodecParameters ?? vStream.codecpar;
        vInfo = { index: vStream.index, codec: codecId, codecpar, width: codecpar.width ?? 0, height: codecpar.height ?? 0, framerate_num: codecpar.frameRate.num, framerate_den: codecpar.frameRate.den, avStream: vStream };
    }
    if (aStream) {
        const codecId = aStream.codecpar.codecId;
        if (!allowedAudioCodec.has(codecId)) { cleanup(); throw new Error("Audio codec not allowed"); }
        aInfo = { index: aStream.index, codec: codecId, codecpar: aStream.codecpar, sample_rate: aStream.codecpar.sampleRate || 0, avStream: aStream };
    }
    const packetIterator = demuxer.packets();
    const applyBitStreamFilters = async (input, filters) => {
        let packets = [input];
        for (const filter of filters) {
            let newPackets = [];
            for (const packet of packets) { newPackets = [...newPackets, ...(await filter.filterAll(packet))]; packet?.free(); }
            if (!input) newPackets.push(null);
            packets = newPackets;
        }
        return packets;
    };
    const readFrame = pDebounce.promise(async () => {
        let resume = true;
        while (resume) {
            try {
                const { value: inPacket, done } = await packetIterator.next();
                if (done) {
                    const packets = await applyBitStreamFilters(null, vbsf);
                    for (const packet of packets) { if (packet) vPipe.write(packet); }
                    cleanup(); return;
                } else if (inPacket) {
                    const si = inPacket.streamIndex;
                    if (vInfo && vInfo.index === si) {
                        const packets = await applyBitStreamFilters(inPacket.clone(), vbsf);
                        for (const packet of packets) { if (packet) resume &&= vPipe.write(packet); }
                    } else if (aInfo && aInfo.index === si) {
                        resume &&= aPipe.write(inPacket.clone());
                    }
                    inPacket.free();
                }
            } catch (_) { cleanup(); return; }
        }
    });
    vPipe.on("drain", () => readFrame());
    aPipe.on("drain", () => readFrame());
    readFrame();
    return {
        video: vInfo ? { ...vInfo, stream: vPipe } : undefined,
        audio: aInfo ? { ...aInfo, stream: aPipe } : undefined,
    };
}
`;

try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
    console.log('Patched LibavDemuxer.js successfully');
} catch (e) {
    console.error('Failed to patch LibavDemuxer.js:', e.message);
}
