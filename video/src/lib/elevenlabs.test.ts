import { describe, expect, it, vi } from 'vitest';
import { alignmentToWords, chunkCaptions } from '../domain/captions.ts';
import {
  ELEVENLABS_OUTPUT_FORMAT,
  synthesizeMockWithTimestamps,
  synthesizeWithTimestamps,
} from './elevenlabs.ts';

describe('src/lib/elevenlabs.ts', () => {
  it('calls POST /v1/text-to-speech/{voice_id}/with-timestamps with xi-api-key, model_id, and output_format=mp3_44100_128', async () => {
    const fakeMp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 0x00, 0x01, 0x02]);
    const fakeBase64 = Buffer.from(fakeMp3Bytes).toString('base64');

    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          audio_base64: fakeBase64,
          alignment: {
            characters: ['M', 'e', 'r', 'h', 'a', 'b', 'a'],
            character_start_times_seconds: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
            character_end_times_seconds: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await synthesizeWithTimestamps({
      apiKey: 'el-secret-key',
      voiceId: 'voice-tr-123',
      modelId: 'eleven_multilingual_v2',
      text: 'Merhaba',
      baseUrl: 'https://api.elevenlabs.io/',
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0];
    expect(requestUrl).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/voice-tr-123/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
    );
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({
        'xi-api-key': 'el-secret-key',
        'Content-Type': 'application/json',
      })
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      text: 'Merhaba',
      model_id: 'eleven_multilingual_v2',
    });

    expect(Array.from(result.audioBytes)).toEqual(Array.from(fakeMp3Bytes));
    expect(result.alignment.characters.join('')).toBe('Merhaba');
  });

  it('throws a descriptive error when response payload is missing alignment or has mismatched arrays', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          audio_base64: Buffer.from('abc').toString('base64'),
          alignment: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      synthesizeWithTimestamps({
        apiKey: 'el-secret-key',
        voiceId: 'voice-tr-123',
        modelId: 'eleven_multilingual_v2',
        text: 'Merhaba',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrowError(/missing character alignment object/);
  });

  describe('emotion tag guard', () => {
    const MODEL_V4 = 'eleven_v4';
    const MODEL_V3 = 'eleven_v3';
    const MODEL_MULTILINGUAL_V2 = 'eleven_multilingual_v2';

    function buildSuccessFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
      const fakeMp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0xc4]);
      return vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audio_base64: Buffer.from(fakeMp3Bytes).toString('base64'),
            alignment: {
              characters: ['a'],
              character_start_times_seconds: [0],
              character_end_times_seconds: [0.1],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    }

    function sentText(mockFetch: ReturnType<typeof buildSuccessFetch>): string {
      const [, requestInit] = mockFetch.mock.calls[0];
      const body = JSON.parse(String(requestInit?.body)) as { text: string };
      return body.text;
    }

    it('keeps bracketed audio tags unchanged for eleven_v4 and eleven_v3 without warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      for (const modelId of [MODEL_V4, MODEL_V3]) {
        const mockFetch = buildSuccessFetch();
        await synthesizeWithTimestamps({
          apiKey: 'el-secret-key',
          voiceId: 'voice-tr-123',
          modelId,
          text: '[thoughtful] Merhaba [pause] dünya',
          fetchImpl: mockFetch,
        });
        expect(sentText(mockFetch)).toBe('[thoughtful] Merhaba [pause] dünya');
      }

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('strips bracketed markers and warns when a non-v3/v4 model is configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const mockFetch = buildSuccessFetch();

      await synthesizeWithTimestamps({
        apiKey: 'el-secret-key',
        voiceId: 'voice-tr-123',
        modelId: MODEL_MULTILINGUAL_V2,
        text: '[thoughtful] Merhaba   [pause]  dünya',
        fetchImpl: mockFetch,
      });

      expect(sentText(mockFetch)).toBe('Merhaba dünya');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain(MODEL_MULTILINGUAL_V2);
      warnSpy.mockRestore();
    });

    it('does not warn when a non-v3/v4 model receives text without markers', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const mockFetch = buildSuccessFetch();

      await synthesizeWithTimestamps({
        apiKey: 'el-secret-key',
        voiceId: 'voice-tr-123',
        modelId: MODEL_MULTILINGUAL_V2,
        text: 'Merhaba dünya',
        fetchImpl: mockFetch,
      });

      expect(sentText(mockFetch)).toBe('Merhaba dünya');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('rejects text that only contains markers for a non-v3/v4 model', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const mockFetch = buildSuccessFetch();

      await expect(
        synthesizeWithTimestamps({
          apiKey: 'el-secret-key',
          voiceId: 'voice-tr-123',
          modelId: MODEL_MULTILINGUAL_V2,
          text: '[pause]',
          fetchImpl: mockFetch,
        })
      ).rejects.toThrowError(/empty after removing unsupported emotion tags/);
      expect(mockFetch).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('emotion markers in synthesizeMockWithTimestamps', () => {
    const MOCK_PAUSE_SECONDS = 0.6;
    const MOCK_SPACE_SECONDS = 0.06;

    function startOf(
      alignment: { characters: string[]; character_start_times_seconds: number[] },
      character: string
    ): number {
      const index = alignment.characters.indexOf(character);
      return alignment.character_start_times_seconds[index];
    }

    it('never includes marker characters in the mock alignment', () => {
      const result = synthesizeMockWithTimestamps('[thoughtful] Merhaba [long pause] dünya');
      const spoken = result.alignment.characters.join('');
      expect(spoken).not.toMatch(/[[\]]/);
      expect(spoken.replace(/\s+/g, '')).toBe('Merhabadünya');
    });

    it('inserts silence for pause markers before the following speech', () => {
      const plain = synthesizeMockWithTimestamps('Merhaba dünya');
      const paused = synthesizeMockWithTimestamps('Merhaba [pause] dünya');
      // The extra space left by the marker adds one mock space, and the pause adds silence.
      const delta = startOf(paused.alignment, 'd') - startOf(plain.alignment, 'd');
      expect(delta).toBeCloseTo(MOCK_PAUSE_SECONDS + MOCK_SPACE_SECONDS, 3);
    });

    it('adds no time for non-pause markers such as [thoughtful]', () => {
      const plain = synthesizeMockWithTimestamps('Merhaba dünya');
      const thoughtful = synthesizeMockWithTimestamps('[thoughtful]Merhaba dünya');
      expect(thoughtful.alignment.character_start_times_seconds).toEqual(
        plain.alignment.character_start_times_seconds
      );
    });

    it('rejects text that contains only markers', () => {
      expect(() => synthesizeMockWithTimestamps('[pause]')).toThrowError(
        /empty after removing emotion markers/
      );
    });
  });

  it('generates valid MPEG-1 Layer III silent MP3 frames and Turkish character alignment in synthesizeMockWithTimestamps', () => {
    const text = 'Merhaba arkadaşlar, bu hafta yazılım dünyasında neler oldu?';
    const result = synthesizeMockWithTimestamps(text);

    // Every MPEG-1 Layer III 128kbps 44.1kHz frame is 417 bytes starting with 0xFF 0xFB 0x90 0xC4
    expect(result.audioBytes.byteLength).toBeGreaterThan(0);
    expect(result.audioBytes.byteLength % 417).toBe(0);
    expect(Array.from(result.audioBytes.slice(0, 4))).toEqual([0xff, 0xfb, 0x90, 0xc4]);

    const words = alignmentToWords(result.alignment);
    expect(words.map((w) => w.word)).toEqual([
      'Merhaba',
      'arkadaşlar,',
      'bu',
      'hafta',
      'yazılım',
      'dünyasında',
      'neler',
      'oldu?',
    ]);

    const captions = chunkCaptions(words, 42);
    expect(captions.length).toBeGreaterThan(0);
  });
});

