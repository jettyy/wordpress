import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

/**
 * 썸네일 배경 그림 생성.
 *
 * 왜 그림만 만들고 글자는 안 넣는가 —
 * 이미지 생성 모델은 한글을 자주 뭉갠다. "통합 서열표 TOP 100" 을 그려 달라고 하면
 * 열 장 중 몇 장은 글자가 깨져 나오고, 100편을 돌리면 그걸 일일이 확인할 수 없다.
 *
 * 그래서 역할을 나눈다.
 *   이미지 API  →  글자 없는 배경 그림만
 *   HTML 템플릿 →  그 위에 한글 문구를 얹기 (브라우저가 그리니 절대 안 깨진다)
 *
 * 이러면 가장 싼 모델을 써도 되고, 생성이 실패해도 기존 단색 썸네일로
 * 그냥 돌아가면 된다. 글이 막히지 않는다.
 *
 * 구글은 이미 한 번 API 를 갈아엎었다. (Imagen 4 의 :predict 엔드포인트는
 * 2026-08-17 에 종료되고 Gemini 의 :generateContent 로 넘어갔다.)
 * 그래서 두 가지 호출 형식을 모두 지원하고, 모델 이름은 설정에서 바꾸게 뒀다.
 */

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 이 값들만 구글이 받아준다. 다른 값을 넣으면 조용히 기본값(1:1)으로 돌아간다. */
const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

/** 썸네일 비율(1200x630 등)에 가장 가까운 허용 비율을 고른다. */
export function pickAspectRatio(width, height) {
  const wanted = Number(width) / Number(height);
  if (!Number.isFinite(wanted) || wanted <= 0) return '16:9';
  let best = '16:9';
  let bestGap = Infinity;
  for (const ratio of ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const gap = Math.abs((w / h) - wanted);
    if (gap < bestGap) { bestGap = gap; best = ratio; }
  }
  return best;
}

/**
 * 그림 프롬프트.
 *
 * "글자를 넣지 마라" 를 여러 표현으로 반복한다. 한 번만 말하면 모델이
 * 간판이나 표지판 형태로 글자를 그려 넣는 일이 잦다.
 */
export function buildImagePrompt(spec, style) {
  const scene = String(spec.scene || '').trim()
    || `a clean conceptual illustration about ${spec.headline || 'an informative article'}`;

  const looks = {
    flat: 'flat vector illustration, simple geometric shapes, soft muted palette, generous negative space',
    soft: 'soft gradient illustration, gentle rounded shapes, calm pastel palette, lots of empty space',
    photo: 'clean minimal photograph, shallow depth of field, soft natural light, uncluttered composition',
    line: 'minimal line art illustration, thin confident strokes, two tone palette, airy composition',
  }[style] || 'flat vector illustration, soft muted palette, generous negative space';

  return [
    scene,
    looks,
    // 글자를 얹을 자리를 비워두게 한다. 안 그러면 가운데가 꽉 차서 문구가 안 보인다.
    'composition keeps the left half and the center visually calm and uncluttered so text can be placed there',
    'no text, no letters, no words, no numbers, no typography, no captions, no labels',
    'no signage, no billboards, no book titles, no watermark, no logo, no signature, no UI elements',
    'blog header background image, wide banner',
  ].join('. ');
}

/* ------------------------------------------------------------------ */
/* 응답에서 이미지 꺼내기                                                */
/* ------------------------------------------------------------------ */

/** Gemini(:generateContent) 응답에서 base64 이미지를 찾는다. */
function fromGenerateContent(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    // SDK 판마다 camelCase 와 snake_case 가 섞여 온다. 둘 다 본다.
    const inline = part?.inlineData || part?.inline_data;
    const data = inline?.data;
    if (data) return { data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
  }
  return null;
}

/** Imagen(:predict) 응답에서 base64 이미지를 찾는다. */
function fromPredict(json) {
  for (const prediction of json?.predictions || []) {
    const data = prediction?.bytesBase64Encoded || prediction?.bytes_base64_encoded;
    if (data) return { data, mimeType: prediction.mimeType || prediction.mime_type || 'image/png' };
  }
  return null;
}

/** 모델이 글자만 돌려보낸 경우 그 이유를 알려준다. */
function refusalText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text).filter(Boolean).join(' ').trim();
  const blocked = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
  if (text) return text.slice(0, 200);
  if (blocked) return `모델이 생성을 거부했습니다 (${blocked})`;
  return '';
}

/* ------------------------------------------------------------------ */
/* 호출                                                                */
/* ------------------------------------------------------------------ */

function explain(status, json, model) {
  const message = json?.error?.message || '';
  if (status === 400 && /API key not valid/i.test(message)) {
    return 'API 키가 올바르지 않습니다. aistudio.google.com 에서 키를 다시 확인해 주세요.';
  }
  if (status === 403) {
    return `이 API 키로는 이미지 생성을 쓸 수 없습니다 (403). ${message}`;
  }
  if (status === 404) {
    return `'${model}' 모델을 찾을 수 없습니다 (404). `
      + '구글이 이미지 모델을 자주 교체합니다. (Imagen 4 계열은 2026년 8월에 종료되었습니다) '
      + '설정에서 모델 이름을 현재 쓸 수 있는 것으로 바꿔 주세요.';
  }
  if (status === 429) {
    return '이미지 생성 한도에 걸렸습니다 (429). 무료 등급이라면 잠시 뒤에 다시 시도해 주세요.';
  }
  return `이미지 생성에 실패했습니다 (${status}). ${message || '(내용 없음)'}`;
}

/**
 * 배경 그림 한 장을 만든다.
 *
 * @returns {Promise<{dataUri: string, model: string, bytes: number}>}
 * @throws  실패하면 사람이 읽을 수 있는 이유를 담아 던진다. 부르는 쪽에서 잡아 넘긴다.
 */
export async function generateBackground(spec, { signal, aspectRatio } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  const model = String(image.model || '').trim();

  if (!apiKey) throw new Error('이미지 API 키가 비어 있습니다.');
  if (!model) throw new Error('이미지 모델 이름이 비어 있습니다.');

  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
  const prompt = buildImagePrompt(spec, image.style);

  // Imagen 계열은 :predict, Gemini 계열은 :generateContent 를 쓴다.
  const isImagen = /^imagen/i.test(model);
  const url = `${HOST}/${encodeURIComponent(model)}:${isImagen ? 'predict' : 'generateContent'}`;

  const body = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }
    : {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // 이걸 빼면 그림 대신 "그려드리겠습니다" 같은 글만 돌아온다.
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: ratio },
      },
    };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(image.timeoutMs || 120000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('이미지 생성이 제한 시간 안에 끝나지 않았습니다.');
    }
    throw new Error(`이미지 API 에 연결하지 못했습니다: ${error.cause?.message || error.message}`);
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `이미지 API 가 JSON 이 아닌 응답을 보냈습니다 (${response.status}). `
      + `앞부분: ${text.slice(0, 140).replace(/\s+/g, ' ')}`,
    );
  }

  if (!response.ok) throw new Error(explain(response.status, json, model));

  const found = isImagen ? fromPredict(json) : fromGenerateContent(json);
  if (!found) {
    const why = refusalText(json);
    throw new Error(`응답에 이미지가 없습니다.${why ? ` ${why}` : ''}`);
  }

  return {
    dataUri: `data:${found.mimeType};base64,${found.data}`,
    model,
    bytes: Math.round((found.data.length * 3) / 4),
  };
}

/**
 * 썸네일용 배경을 만들되, 실패해도 글을 막지 않는다.
 * 끄여 있거나 키가 없으면 조용히 null 을 준다.
 *
 * @returns {Promise<{dataUri: string, model: string, bytes: number}|null>}
 */
export async function maybeGenerateBackground(spec, { signal, width, height, jobId = '' } = {}) {
  const { image } = getSettings();
  if (!image.enabled) return null;
  if (!String(image.apiKey || '').trim()) {
    logger.warn('이미지 배경 생성이 켜져 있지만 API 키가 없습니다. 단색 썸네일로 만듭니다.', { jobId });
    return null;
  }

  try {
    const result = await generateBackground(spec, {
      signal,
      aspectRatio: pickAspectRatio(width, height),
    });
    logger.info(
      `썸네일 배경 그림을 만들었습니다. (${result.model}, ${Math.round(result.bytes / 1024)}KB)`,
      { jobId },
    );
    return result;
  } catch (error) {
    // 그림은 글의 부속물이다. 여기서 실패했다고 1,800자짜리 글을 버리지 않는다.
    logger.warn(`배경 그림 생성 실패, 단색 썸네일로 만듭니다: ${error.message}`, { jobId });
    return null;
  }
}
