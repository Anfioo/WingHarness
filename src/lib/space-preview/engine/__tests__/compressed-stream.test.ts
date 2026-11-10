// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { decompressArchiveStream, decompressStream, isTar } from '../compressed-stream';

describe('standalone compressed files', () => {
  it.each([
    [
      'bz2',
      'QlpoOTFBWSZTWQVA6egAAA8AeSONAwAALwZkB4AgADFABiNNNGhQADRoZqbglwWDkGLMkkw5itF5Y+dVAKfF3JFOFCQBUDp6AA==',
    ],
    [
      'xz',
      '/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAg54us56uL5Y6L57yp5rWB5a6M5pW05Lit5paH5YaF5a65AAAAAC+DNQm/XdboAAE5Ic8oa2IftvN9AQAAAAAEWVo=',
    ],
  ])('reads a real Python-generated %s single-file stream', async (format, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(await decompressArchiveStream(bytes, format))).toBe(
      '独立压缩流完整中文内容',
    );
    await expect(decompressArchiveStream(bytes.slice(0, 20), format)).rejects.toThrow();
  });
  it('reads GZIP data completely and rejects truncated streams', () => {
    const bytes = gzipSync(new TextEncoder().encode('完整中文内容'));
    expect(new TextDecoder().decode(decompressStream(bytes, false))).toBe('完整中文内容');
    expect(() => decompressStream(bytes.slice(0, 15), false)).toThrow();
    expect(isTar(new Uint8Array(1024))).toBe(false);
  });
});
