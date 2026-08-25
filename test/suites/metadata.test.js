'use strict';

const { createMetadataSandbox } = require('../harness');

/**
 * A stand-in for the piexifjs `@require`. It records what it was handed and returns a
 * recognisable APP1 segment, so the tests can assert on the tags the script asks for and on how
 * that segment is unwrapped for WebP — without depending on the real library, which is not
 * installable here.
 */
function fakePiexif({ failFullDump = false } = {}) {
  const calls = { dumps: [], inserts: [] };
  const tiff = 'II*\x00TIFFPAYLOAD';
  const segment = `\xFF\xE1\x00\x14Exif\x00\x00${tiff}`;
  return {
    calls,
    tiff,
    segment,
    ImageIFD: {
      ImageDescription: 270, Make: 271, Model: 272, Software: 305, Artist: 315,
      DateTime: 306, XPTitle: 40091, XPComment: 40092, XPAuthor: 40093,
      XPKeywords: 40094, XPSubject: 40095,
    },
    ExifIFD: {
      DateTimeOriginal: 36867, DateTimeDigitized: 36868,
      UserComment: 37510, ImageUniqueID: 42016,
    },
    dump(obj) {
      calls.dumps.push(obj);
      if (failFullDump && calls.dumps.length === 1) throw new Error('unsupported tag');
      return segment;
    },
    insert(exifBytes, binary) {
      calls.inserts.push({ exifBytes, binary });
      return `INSERTED${binary}`;
    },
  };
}

// ── independent oracles, so nothing is graded by the code under test ───────────────────────
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function readPngChunks(u8) {
  const out = [];
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8;
  while (off + 12 <= u8.length) {
    const length = view.getUint32(off, false);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const data = u8.subarray(off + 8, off + 8 + length);
    const stored = view.getUint32(off + 8 + length, false);
    out.push({ type, data, crcOk: crc32(u8.subarray(off + 4, off + 8 + length)) === stored });
    off += 12 + length;
  }
  return out;
}

function readRiff(u8) {
  const out = [];
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 12;
  while (off + 8 <= u8.length) {
    const fourcc = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const size = view.getUint32(off + 4, true);
    out.push({ fourcc, size, data: u8.subarray(off + 8, off + 8 + size) });
    off += 8 + size + (size % 2);
  }
  return out;
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────
function makePng() {
  const chunk = (type, data) => {
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body), false);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, 2, false);      // width
  ihdrView.setUint32(4, 3, false);      // height
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = 6;                          // colour type
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Uint8Array.from([1, 2, 3, 4, 5])),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** A minimal lossy WebP: RIFF/WEBP plus one VP8 chunk with a valid key-frame header. */
function makeSimpleWebp(width = 640, height = 480, payloadLen = 21) {
  const vp8 = new Uint8Array(payloadLen);
  vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a;      // start code
  vp8[6] = width & 0xff; vp8[7] = (width >> 8) & 0x3f;
  vp8[8] = height & 0xff; vp8[9] = (height >> 8) & 0x3f;
  for (let i = 10; i < payloadLen; i++) vp8[i] = i;
  const pad = vp8.length % 2;
  const riffSize = 4 + 8 + vp8.length + pad;
  const out = new Uint8Array(8 + riffSize);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);             // 'RIFF'
  view.setUint32(4, riffSize, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);             // 'WEBP'
  out.set([0x56, 0x50, 0x38, 0x20], 12);            // 'VP8 '
  view.setUint32(16, vp8.length, true);
  out.set(vp8, 20);
  return out;
}

const POST = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  prompt: 'A red fox in snow',
  parentPrompt: 'A fox',
  rootPrompt: 'An animal',
  parentId: 'parent-1',
  rootId: 'root-1',
  isChild: true,
  createTime: '2026-06-01T10:20:30Z',
  model: 'grok-image-v2',
  mediaType: 'MEDIA_POST_TYPE_IMAGE',
  isLiked: true,
  childPostCount: 2,
  childImageCount: 2,
  childVideoCount: 0,
  videoCount: 0,
  mediaUrl: 'https://assets.grok.com/x.webp',
};

module.exports = {
  name: 'image metadata — EXIF, PNG text chunks, WebP container',
  async run(t) {
    const piexif = fakePiexif();
    const m = createMetadataSandbox({ piexif });

    t.group('text shaping');
    t.equal('short text is untouched', m.truncateMetadataText('abc'), 'abc');
    t.equal('long text is ellipsised to the cap', m.truncateMetadataText('abcdef', 4), 'abc…');
    t.equal('accents fold to ASCII', m.toAsciiText('café'), 'cafe');
    t.equal('unmappable characters are dropped', m.toAsciiText('a 你好 b'), 'a  b');
    const asciiJson = m.toAsciiJson({ a: 'héllo 你' });
    t.ok('JSON escapes every non-ASCII byte', /^[\x00-\x7f]*$/.test(asciiJson), asciiJson);
    t.equal('and it still parses back', JSON.parse(asciiJson).a, 'héllo 你');

    t.group('dates');
    t.equal('ISO becomes EXIF form', m.formatExifDateTime('2026-06-01T10:20:30Z'), '2026:06:01 10:20:30');
    t.equal('an unparseable date yields nothing', m.formatExifDateTime('nope'), '');
    t.equal('an absent date yields nothing', m.formatExifDateTime(''), '');
    const pngDate = m.formatPngCreationTime('2026-06-01T10:20:30Z');
    t.ok('PNG creation time is RFC 1123',
      /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(pngDate), pngDate);

    t.group('UCS-2 encoding for the Windows XP tags');
    t.equal('ASCII becomes little-endian pairs plus a terminator',
      m.ucs2Bytes('AB'), [65, 0, 66, 0, 0, 0]);
    t.equal('a high code unit keeps both bytes', m.ucs2Bytes('é'), [0xe9, 0x00, 0, 0]);

    t.group('the metadata record');
    const meta = m.buildPostMetadata(POST);
    const fields = JSON.parse(meta.json);
    t.equal('the prompt is carried', fields.prompt, 'A red fox in snow');
    t.equal('so is the parent prompt', fields.parentPrompt, 'A fox');
    t.equal('and the root prompt', fields.rootPrompt, 'An animal');
    t.equal('and the owning root id', fields.rootId, 'root-1');
    t.equal('like state survives as a boolean', fields.isLiked, true);
    t.equal('the post URL is derived', fields.postUrl, `https://grok.com/imagine/post/${POST.id}`);
    t.ok('the script version is stamped', String(fields.taggedBy).includes('grokSearch.js'), fields.taggedBy);
    const bare = JSON.parse(m.buildPostMetadata({ id: 'x', prompt: 'p' }).json);
    t.ok('empty values are dropped rather than written blank', !('rootPrompt' in bare), bare);
    t.ok('keywords describe the post',
      meta.keywords.includes('liked') && meta.keywords.includes('variation'), meta.keywords);
    t.equal('software names the model', meta.software, 'Grok Imagine (grok-image-v2)');

    const parentMeta = m.buildPostMetadata({ ...POST, isChild: false, isLiked: false });
    t.ok('a top-level post is tagged "original"', parentMeta.keywords.includes('original'), parentMeta.keywords);
    t.ok('and carries no parent fields', !('parentId' in JSON.parse(parentMeta.json)), parentMeta.json);

    t.group('EXIF dictionary');
    const dicts = m.buildExifDicts(meta);
    t.equal('ImageDescription holds the prompt', dicts['0th'][270], 'A red fox in snow');
    t.equal('DateTime is the EXIF form', dicts['0th'][306], '2026:06:01 10:20:30');
    t.equal('Model holds the generator model', dicts['0th'][272], 'grok-image-v2');
    t.ok('XPComment is a UCS-2 byte array', Array.isArray(dicts['0th'][40092]), dicts['0th'][40092]);
    t.equal('ImageUniqueID holds the post id', dicts.Exif[42016], POST.id);
    t.ok('UserComment is ASCII-tagged JSON',
      String(dicts.Exif[37510]).startsWith('ASCII\x00\x00\x00{'),
      JSON.stringify(String(dicts.Exif[37510]).slice(0, 20)));
    t.ok('no tag is written under an undefined id',
      !Object.keys(dicts['0th']).includes('undefined')
        && !Object.keys(dicts.Exif).includes('undefined'),
      Object.keys(dicts['0th']));

    t.group('EXIF dump falls back rather than losing everything');
    const flaky = fakePiexif({ failFullDump: true });
    const mf = createMetadataSandbox({ piexif: flaky });
    const seg = mf.dumpExifSegment(mf.buildPostMetadata(POST));
    t.equal('a rejected full dump is retried minimally', flaky.calls.dumps.length, 2);
    t.ok('and a segment still comes back', typeof seg === 'string' && seg.length > 0, seg);
    t.equal('the retry keeps the prompt', flaky.calls.dumps[1]['0th'][270], 'A red fox in snow');

    t.group('JPEG');
    const jpegIn = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    t.ok('a JPEG is recognised', m.isJpegBytes(jpegIn));
    m.embedMetadataInJpeg(jpegIn.buffer, meta);
    t.equal('piexif.insert is handed the segment', piexif.calls.inserts.at(-1).exifBytes, piexif.segment);

    t.group('the WebP EXIF chunk carries bare TIFF, not a JPEG APP1 segment');
    t.equal('the APP1 marker and Exif identifier are stripped',
      String.fromCharCode(...m.buildTiffExifBytes(meta)), piexif.tiff);

    t.group('PNG');
    const png = makePng();
    t.ok('a PNG is recognised', m.isPngBytes(png));
    t.equal('the insert point is just past IHDR', m.pngHeaderEnd(png), 33);
    t.equal('a truncated file has no insert point', m.pngHeaderEnd(png.subarray(0, 10)), -1);
    t.equal('a non-PNG has no insert point', m.pngHeaderEnd(makeSimpleWebp()), -1);

    const taggedPng = new Uint8Array(m.embedMetadataInPng(png.buffer, meta));
    const chunks = readPngChunks(taggedPng);
    const types = chunks.map(c => c.type);
    t.equal('the signature is untouched',
      [...taggedPng.subarray(0, 8)], [...png.subarray(0, 8)]);
    t.equal('IHDR still comes first', types[0], 'IHDR');
    t.equal('IEND still comes last', types.at(-1), 'IEND');
    t.ok('IDAT survives', types.includes('IDAT'), types);
    t.ok('text chunks are inserted before IDAT',
      types.indexOf('tEXt') > 0 && types.indexOf('tEXt') < types.indexOf('IDAT'), types);
    t.ok('every chunk CRC is valid', chunks.every(c => c.crcOk), types);

    const textOf = keyword => {
      for (const c of chunks) {
        if (c.type !== 'tEXt') continue;
        const s = String.fromCharCode(...c.data);
        const nul = s.indexOf('\x00');
        if (s.slice(0, nul) === keyword) return s.slice(nul + 1);
      }
      return null;
    };
    t.equal('Description holds the prompt', textOf('Description'), 'A red fox in snow');
    t.equal('the AI-tool "prompt" key holds it too', textOf('prompt'), 'A red fox in snow');
    t.ok('"parameters" names the model',
      String(textOf('parameters')).includes('grok-image-v2'), textOf('parameters'));
    t.equal('Comment carries the full JSON', JSON.parse(textOf('Comment')).id, POST.id);
    t.equal('Source links back to the post', textOf('Source'), `https://grok.com/imagine/post/${POST.id}`);

    t.group('PNG text encoding');
    t.ok('plain ASCII is Latin-1', m.isLatin1Text('a b c'));
    t.ok('accented Latin-1 is too', m.isLatin1Text('café'));
    t.ok('CJK is not', !m.isLatin1Text('你好'));
    const cjkMeta = m.buildPostMetadata({ ...POST, prompt: '你好 fox' });
    const cjkChunks = readPngChunks(new Uint8Array(m.embedMetadataInPng(png.buffer, cjkMeta)));
    const cjkTypes = cjkChunks.map(c => c.type);
    t.ok('non-Latin-1 text goes into iTXt instead', cjkTypes.includes('iTXt'), cjkTypes);
    t.ok('and those chunks are still valid', cjkChunks.every(c => c.crcOk), cjkTypes);

    t.group('WebP — reading a simple file');
    const webp = makeSimpleWebp(640, 480);
    t.ok('it is recognised', m.isWebpBytes(webp));
    t.ok('a PNG is not mistaken for one', !m.isWebpBytes(png));
    const rawChunks = m.readRiffChunks(webp);
    t.equal('one image chunk is found', rawChunks.map(c => c.fourcc), ['VP8 ']);
    t.equal('canvas size comes out of the bitstream',
      m.readWebpCanvasSize(rawChunks), { width: 640, height: 480 });

    t.group('WebP — tagging a simple file');
    const taggedWebp = new Uint8Array(m.embedMetadataInWebp(webp.buffer, meta));
    const riff = readRiff(taggedWebp);
    t.equal('VP8X is synthesized and metadata appended in spec order',
      riff.map(c => c.fourcc), ['VP8X', 'VP8 ', 'EXIF', 'XMP ']);
    t.equal('the RIFF size field matches the file',
      new DataView(taggedWebp.buffer).getUint32(4, true), taggedWebp.length - 8);
    t.equal('the form type is still WEBP',
      String.fromCharCode(...taggedWebp.subarray(8, 12)), 'WEBP');

    const vp8x = riff[0].data;
    t.equal('VP8X is exactly 10 bytes', riff[0].size, 10);
    t.ok('the EXIF flag is set', (vp8x[0] & 0x08) !== 0, vp8x[0].toString(2));
    t.ok('the XMP flag is set', (vp8x[0] & 0x04) !== 0, vp8x[0].toString(2));
    t.equal('canvas width is stored minus one, little-endian',
      vp8x[4] | (vp8x[5] << 8) | (vp8x[6] << 16), 639);
    t.equal('canvas height likewise', vp8x[7] | (vp8x[8] << 8) | (vp8x[9] << 16), 479);
    t.equal('the image data is copied through byte for byte',
      [...riff[1].data], [...rawChunks[0].data]);
    t.equal('the EXIF chunk is the bare TIFF block',
      String.fromCharCode(...riff[2].data), piexif.tiff);
    const xmp = String.fromCharCode(...riff[3].data);
    t.ok('the XMP packet carries the prompt', xmp.includes('A red fox in snow'), xmp.slice(0, 160));
    t.ok('and is a well-formed packet',
      xmp.startsWith('<?xpacket begin=') && xmp.trimEnd().endsWith('<?xpacket end="w"?>'), xmp.slice(-40));

    t.group('WebP — odd-sized chunks stay padded');
    const oddTagged = new Uint8Array(m.embedMetadataInWebp(makeSimpleWebp(640, 480, 21).buffer, meta));
    const oddRiff = readRiff(oddTagged);
    t.equal('the odd image chunk still declares its true length', oddRiff[1].size, 21);
    t.equal('and everything after it still parses',
      oddRiff.map(c => c.fourcc), ['VP8X', 'VP8 ', 'EXIF', 'XMP ']);
    t.equal('the file length stays even', oddTagged.length % 2, 0);

    t.group('WebP — re-tagging is idempotent, not cumulative');
    const twice = new Uint8Array(m.embedMetadataInWebp(taggedWebp.buffer, meta));
    t.equal('a second pass does not duplicate the metadata chunks',
      readRiff(twice).map(c => c.fourcc), ['VP8X', 'VP8 ', 'EXIF', 'XMP ']);
    t.equal('and the file does not grow', twice.length, taggedWebp.length);

    t.group('WebP — an existing VP8X keeps its flags');
    const withIcc = new Uint8Array(taggedWebp);
    withIcc[20] |= 0x20;      // the VP8X flag byte sits at file offset 12 + 8
    const reTagged = readRiff(new Uint8Array(m.embedMetadataInWebp(withIcc.buffer, meta)));
    t.ok('an unrelated flag survives the rewrite',
      (reTagged[0].data[0] & 0x20) !== 0, reTagged[0].data[0].toString(2));

    t.group('WebP — refusing to guess');
    const noSize = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x58, 0x58, 0x58, 0x58, 0, 0, 0, 0,
    ]);
    t.ok('a file with no readable canvas size is returned untouched',
      m.embedMetadataInWebp(noSize.buffer, meta) === noSize.buffer);

    t.group('dispatch by magic bytes');
    const unknown = new Blob([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])]);
    t.ok('an unrecognised format is passed through as the same blob',
      (await m.embedMetadataInImageBlob(unknown, POST)) === unknown);
    const pngBlob = new Blob([png], { type: 'image/png' });
    const outPng = await m.embedMetadataInImageBlob(pngBlob, POST);
    t.ok('a PNG comes back larger', outPng.size > pngBlob.size, `${pngBlob.size} -> ${outPng.size}`);
    t.equal('and keeps its MIME type', outPng.type, 'image/png');
    const webpBlob = new Blob([webp], { type: 'image/webp' });
    const outWebp = await m.embedMetadataInImageBlob(webpBlob, POST);
    t.ok('a WebP comes back larger too', outWebp.size > webpBlob.size, `${webpBlob.size} -> ${outWebp.size}`);
  },
};
