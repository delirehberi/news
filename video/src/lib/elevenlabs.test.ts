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

