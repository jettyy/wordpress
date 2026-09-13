import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { IMAGE_MODEL_FILE, ensureDirs } from '../lib/paths.js';

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
 * 모델은 **자동으로 가장 싼 것을 고른다.** 다만 구글 API 는 가격을 알려주지 않는다.
 * 그래서 둘을 나눠서 쓴다.
 *   - "지금 쓸 수 있는 모델이 무엇인가" → API 에 물어본다 (실시간)
 *   - "그중 무엇이 싼가"              → 아래 가격표 (사람이 관리)
 *
 * 구글은 이미 한 번 API 를 갈아엎었다. (Imagen 4 의 :predict 엔드포인트는
 * 2026-08-17 에 종료되고 Gemini 의 :generateContent 로 넘어갔다.)
 * 그래서 두 호출 형식을 모두 지원하고, 고른 모델이 죽어 있으면
 * 다음으로 싼 모델로 알아서 넘어간다.
 */

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 이 값들만 구글이 받아준다. 다른 값을 넣으면 조용히 기본값(1:1)으로 돌아간다. */
const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

/* ------------------------------------------------------------------ */
/* 가격표                                                              */
/* ------------------------------------------------------------------ */

/**
 * 장당 대략 가격(USD, 1K 해상도 기준). 싼 순서로 정렬된 것이 아니라,
 * 이름 패턴에 값을 매기는 표다. 정렬은 이 값으로 한다.
 *
 * ListModels 응답에는 가격이 없어서 여기에 적어 둘 수밖에 없다.
 * 가격이 바뀌면 이 표만 고치면 된다. 표에 없는 새 모델이 나와도
 * 아래 등급 이름 규칙(lite < fast < flash < pro)으로 대략 짐작한다.
 */
const PRICE_TABLE = [
  { match: /^imagen-[\d.]+-fast/i, usd: 0.02, label: 'Imagen Fast' },
  { match: /flash-lite-image/i, usd: 0.034, label: 'Flash Lite' },
  { match: /^gemini-2\.5-flash-image/i, usd: 0.039, label: 'Flash (구세대)' },
  { match: /^imagen-[\d.]+-ultra/i, usd: 0.06, label: 'Imagen Ultra' },
  { match: /^imagen-[\d.]+-generate/i, usd: 0.04, label: 'Imagen Standard' },
  { match: /pro-image/i, usd: 0.134, label: 'Pro' },
  { match: /flash-image/i, usd: 0.067, label: 'Flash' },
];

/** 표에 없는 새 모델의 가격을 등급 이름으로 짐작한다. */
const TIER_GUESS = [
  { match: /lite/i, usd: 0.035, label: '알 수 없음 (lite 추정)' },
  { match: /fast/i, usd: 0.03, label: '알 수 없음 (fast 추정)' },
  { match: /flash/i, usd: 0.07, label: '알 수 없음 (flash 추정)' },
  { match: /pro|ultra/i, usd: 0.15, label: '알 수 없음 (pro 추정)' },
];

/** 모델 이름 하나에 가격과 등급 이름을 붙인다. */
export function priceOf(id) {
  for (const row of PRICE_TABLE) {
    if (row.match.test(id)) return { usd: row.usd, label: row.label, known: true };
  }
  for (const row of TIER_GUESS) {
    if (row.match.test(id)) return { usd: row.usd, label: row.label, known: false };
  }
  // 등급도 모르겠으면 비싼 쪽으로 본다. 모르는 모델을 골라 비싸게 쓰는 것보다
  // 아는 모델을 쓰는 편이 안전하기 때문이다.
  return { usd: 0.2, label: '알 수 없음', known: false };
}

/* ------------------------------------------------------------------ */
/* 모델 목록 받아오기                                                    */
/* ------------------------------------------------------------------ */

/** 이미지를 만들 수 있는 모델인지. */
export function looksLikeImageModel(model) {
  const id = String(model?.id || '').toLowerCase();
  if (!id) return false;

  // 이미지를 "읽는" 모델과 임베딩 모델을 먼저 걸러낸다.
  if (/embedding|embed|aqa|tts|-live-|vision/i.test(id)) return false;

  const methods = model.methods || [];
  // Imagen 계열은 predict 로 구분된다.
  if (/^imagen/i.test(id) && methods.includes('predict')) return true;

  // Gemini 계열(Nano Banana)은 generateContent 만 표시돼서 이름으로 봐야 한다.
  // supportedGenerationMethods 에 이미지 출력 여부가 안 나온다.
  if (/-image/i.test(id) && methods.includes('generateContent')) return true;

  // 설명에 이미지 생성이라고 적혀 있으면 그것도 본다.
  if (/image generation|generates? images/i.test(model.description || '')
      && methods.includes('generateContent')) return true;

  return false;
}

/** 계정에서 쓸 수 있는 모델 목록을 받아온다. (가격은 안 들어 있다) */
export async function fetchModels(apiKey, { signal, timeoutMs = 30000 } = {}) {
  const models = [];
  let pageToken = '';

  // 목록이 길면 페이지로 나뉘어 온다. 이미지 모델이 뒷장에 있을 수 있다.
  for (let page = 0; page < 10; page += 1) {
    const url = `${HOST}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const response = await fetch(url, {
      headers: { 'x-goog-api-key': apiKey },
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`모델 목록이 JSON 이 아닙니다 (${response.status}). ${text.slice(0, 120)}`);
    }
    if (!response.ok) {
      throw new Error(json?.error?.message || `모델 목록을 받지 못했습니다 (${response.status}).`);
    }

    for (const entry of json.models || []) {
      models.push({
        // 응답의 name 은 "models/gemini-..." 형태다. 앞의 접두사를 뗀다.
        id: String(entry.name || '').replace(/^models\//, ''),
        displayName: entry.displayName || '',
        description: entry.description || '',
        methods: entry.supportedGenerationMethods || [],
      });
    }

    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }
  return models;
}

/** 이미지 모델만 골라 싼 순서로 정렬한다. */
export function rankImageModels(models) {
  return models
    .filter(looksLikeImageModel)
    .map((model) => {
      const price = priceOf(model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        usd: price.usd,
        tier: price.label,
        knownPrice: price.known,
      };
    })
    // 값이 같으면 가격을 아는 쪽을 먼저 쓴다. 추정치로 고르는 위험을 줄인다.
    .sort((a, b) => (a.usd - b.usd) || (Number(b.knownPrice) - Number(a.knownPrice)));
}

/* ------------------------------------------------------------------ */
/* 목록 캐시                                                            */
/* ------------------------------------------------------------------ */

/** 키 자체는 저장하지 않는다. 키가 바뀌었는지만 알면 된다. */
function keyFingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(IMAGE_MODEL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    ensureDirs();
    fs.writeFileSync(IMAGE_MODEL_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.warn(`이미지 모델 목록을 저장하지 못했습니다: ${error.message}`);
  }
  return data;
}

/**
 * 쓸 수 있는 이미지 모델을 싼 순서로 돌려준다.
 *
 * 글 100편을 돌릴 때마다 목록을 받아올 이유는 없다. 하루에 한 번만 받고
 * 나머지는 저장해 둔 것을 쓴다. 키가 바뀌면 다시 받는다.
 *
 * @returns {Promise<{models: Array, at: string, fresh: boolean}>}
 */
export async function getImageModels({ force = false, signal } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  if (!apiKey) throw new Error('이미지 API 키가 비어 있습니다.');

  const fingerprint = keyFingerprint(apiKey);
  const cached = readCache();
  const ttlMs = Math.max(1, Number(image.modelCacheHours) || 24) * 3600 * 1000;

  const usable = cached
    && cached.keyFingerprint === fingerprint
    && Array.isArray(cached.models) && cached.models.length
    && (Date.now() - new Date(cached.at).getTime()) < ttlMs;

  if (usable && !force) return { models: cached.models, at: cached.at, fresh: false };

  const models = rankImageModels(await fetchModels(apiKey, { signal }));
  if (!models.length) {
    throw new Error(
      '이 API 키로 쓸 수 있는 이미지 생성 모델이 하나도 없습니다. '
      + 'aistudio.google.com 에서 키가 이미지 생성을 지원하는지 확인해 주세요.',
    );
  }

  const saved = writeCache({ keyFingerprint: fingerprint, at: new Date().toISOString(), models });
  logger.info(
    `이미지 모델 ${models.length}개를 찾았습니다. 가장 싼 것: ${models[0].id} `
    + `(${models[0].tier}, 장당 약 $${models[0].usd})`,
  );
  return { models: saved.models, at: saved.at, fresh: true };
}

/** 쓸 수 없다고 판명된 모델을 캐시에서 빼둔다. 다음 글부터 건너뛴다. */
function dropModel(id) {
  const cached = readCache();
  if (!cached?.models) return;
  const models = cached.models.filter((model) => model.id !== id);
  if (models.length === cached.models.length) return;
  writeCache({ ...cached, models });
  logger.warn(`'${id}' 을(를) 쓸 수 있는 모델 목록에서 뺐습니다.`);
}

/* ------------------------------------------------------------------ */
/* 프롬프트                                                            */
/* ------------------------------------------------------------------ */

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
  if (status === 403) return `이 API 키로는 이미지 생성을 쓸 수 없습니다 (403). ${message}`;
  if (status === 404) return `'${model}' 모델을 찾을 수 없습니다 (404). ${message}`;
  if (status === 429) {
    return '이미지 생성 한도에 걸렸습니다 (429). 무료 등급이라면 잠시 뒤에 다시 시도해 주세요.';
  }
  return `이미지 생성에 실패했습니다 (${status}). ${message || '(내용 없음)'}`;
}

/** 이 모델이 이제 없다는 뜻의 오류인가. 그렇다면 다음 모델로 넘어가면 된다. */
function modelIsGone(status, json) {
  if (status === 404) return true;
  const message = String(json?.error?.message || '');
  return status === 400 && /not found|not supported|is not available|deprecat/i.test(message);
}

/** 모델 하나로 한 번 시도한다. */
async function attempt(model, prompt, ratio, apiKey, { signal, timeoutMs }) {
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
      signal: signal || AbortSignal.timeout(timeoutMs),
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

  if (!response.ok) {
    const error = new Error(explain(response.status, json, model));
    error.modelGone = modelIsGone(response.status, json);
    throw error;
  }

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
 * 쓸 모델을 순서대로 정한다.
 * 설정에 모델을 직접 적어 뒀으면 그것만, 비워 뒀으면 싼 순서로 여러 개.
 */
async function candidates({ signal }) {
  const { image } = getSettings();
  const manual = String(image.model || '').trim();
  if (manual) return [{ id: manual, tier: '직접 지정', usd: null }];

  const { models } = await getImageModels({ signal });
  // 첫 번째가 죽어 있을 때를 대비해 뒤 후보까지 몇 개 들고 간다.
  return models.slice(0, 4);
}

/**
 * 배경 그림 한 장을 만든다.
 *
 * 모델을 직접 지정하지 않았으면 가장 싼 것부터 시도하고,
 * 그 모델이 없어졌으면 다음으로 싼 것으로 알아서 넘어간다.
 *
 * @returns {Promise<{dataUri, model, bytes, tier, usd, switched}>}
 * @throws  실패하면 사람이 읽을 수 있는 이유를 담아 던진다. 부르는 쪽에서 잡아 넘긴다.
 */
export async function generateBackground(spec, { signal, aspectRatio } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  if (!apiKey) throw new Error('이미지 API 키가 비어 있습니다.');

  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
  const prompt = buildImagePrompt(spec, image.style);
  const timeoutMs = image.timeoutMs || 120000;

  const list = await candidates({ signal });
  let lastError = null;

  for (const [index, candidate] of list.entries()) {
    try {
      const result = await attempt(candidate.id, prompt, ratio, apiKey, { signal, timeoutMs });
      return { ...result, tier: candidate.tier, usd: candidate.usd, switched: index > 0 };
    } catch (error) {
      lastError = error;
      // 모델이 없어진 경우에만 다음 후보로 넘어간다. 키 오류나 한도 초과는
      // 다른 모델로 바꿔도 똑같이 실패하므로 바로 올린다.
      if (!error.modelGone) throw error;
      dropModel(candidate.id);
      if (index < list.length - 1) {
        logger.warn(`'${candidate.id}' 이(가) 없어졌습니다. 다음으로 싼 모델로 시도합니다.`);
      }
    }
  }

  throw new Error(
    `쓸 수 있는 이미지 모델을 찾지 못했습니다. 마지막 오류: ${lastError?.message || '(없음)'}`,
  );
}

/**
 * 썸네일용 배경을 만들되, 실패해도 글을 막지 않는다.
 * 꺼져 있거나 키가 없으면 조용히 null 을 준다.
 *
 * @returns {Promise<{dataUri, model, bytes}|null>}
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
    const cost = result.usd ? `, 장당 약 $${result.usd}` : '';
    logger.info(
      `썸네일 배경 그림을 만들었습니다. (${result.model}${result.tier ? ` · ${result.tier}` : ''}`
      + `${cost}, ${Math.round(result.bytes / 1024)}KB)`,
      { jobId },
    );
    return result;
  } catch (error) {
    // 그림은 글의 부속물이다. 여기서 실패했다고 1,800자짜리 글을 버리지 않는다.
    logger.warn(`배경 그림 생성 실패, 단색 썸네일로 만듭니다: ${error.message}`, { jobId });
    return null;
  }
}
