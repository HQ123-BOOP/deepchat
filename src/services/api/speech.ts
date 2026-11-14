import { ApiError, API_ORIGIN, request } from './client.js'

/**
 * 语音合成接口：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）。
 * 鉴权用 Authorization: Bearer。语音识别已改为设备本地推理，不再走这里。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await request(`${TOOLS_BASE_URL}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}
