import fs from 'node:fs';
import path from 'node:path';
import { SITE_FILE, ensureDirs } from '../lib/paths.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { logger, push } from '../lib/events.js';
import { normalizeSiteUrl, nowIso } from '../lib/util.js';

/**
 * 워드프레스 REST API 클라이언트.
 *
 * 네이버·블로거판은 브라우저를 띄워 에디터를 직접 조작했다. 선택자가 바뀌면
 * 그때마다 깨지는 구조다. 워드프레스는 공식 REST API 와 "응용 프로그램 비밀번호"가
 * 기본으로 들어 있어서, 화면을 흉내 낼 이유가 없다.
 *
 *   - 로그인 창이 필요 없다 (아이디 + 응용 프로그램 비밀번호로 Basic 인증)
 *   - 에디터 선택자가 바뀌어도 안 깨진다
 *   - 대표 이미지, 카테고리, 태그, 슬러그를 정확히 지정할 수 있다
 *
 * 비밀번호는 data/settings.json 에만 저장되고 외부로 나가지 않습니다.
 * (그 파일은 git 에 올라가지 않고, 권한도 600 으로 잠급니다.)
 */

const DEFAULT_TIMEOUT = 45000;

/* ------------------------------------------------------------------ */
/* 저수준 호출                                                          */
/* ------------------------------------------------------------------ */

function credentials() {
  const { url, username, appPassword } = getSettings().site;
  const site = normalizeSiteUrl(url);
  if (!site) throw new Error('워드프레스 사이트 주소를 먼저 입력해 주세요.');
  if (!username) throw new Error('워드프레스 사용자 이름을 입력해 주세요.');
  if (!appPassword) {
    throw new Error(
      '응용 프로그램 비밀번호가 비어 있습니다. '
      + '워드프레스 관리자 > 사용자 > 프로필 > 응용 프로그램 비밀번호 에서 새로 발급해 넣어 주세요.',
    );
  }
  // 워드프레스가 발급할 때 넣어주는 공백은 인증 시 무시된다. 그대로 보내도 되지만
  // 사용자가 앞뒤로 복사한 공백까지 섞이면 실패하므로 여기서 정리한다.
  const token = Buffer.from(`${username}:${appPassword.trim()}`, 'utf8').toString('base64');
  return { site, auth: `Basic ${token}` };
}

/** 응답이 JSON 이 아닐 때(보안 플러그인 차단 등) 무엇이 왔는지 알려준다. */
async function readBody(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function explain(response, body, url) {
  const code = body.json?.code || '';
  const message = body.json?.message || '';

  if (response.status === 401) {
    return '인증에 실패했습니다 (401). 사용자 이름과 응용 프로그램 비밀번호를 확인해 주세요. '
      + '일부 호스팅은 Authorization 헤더를 지워버립니다. 그 경우 .htaccess 에 '
      + 'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1 을 추가해야 합니다.'
      + (message ? ` (원문: ${message})` : '');
  }
  if (response.status === 403) {
    return `권한이 없습니다 (403). 이 계정에 글쓰기 권한이 있는지 확인해 주세요.${message ? ` (${message})` : ''}`;
  }
  if (code === 'rest_no_route' || response.status === 404) {
    return `REST API 경로를 찾지 못했습니다 (404, ${url}). `
      + '워드프레스 주소가 맞는지, REST API 를 막는 플러그인이 있는지 확인해 주세요.';
  }
  if (!body.json) {
    const head = body.text.trim().slice(0, 160).replace(/\s+/g, ' ');
    return `워드프레스가 JSON 이 아닌 응답을 보냈습니다 (${response.status}). `
      + `보안 플러그인이나 캐시가 막고 있을 수 있습니다. 응답 앞부분: ${head || '(빈 응답)'}`;
  }
  return `${message || '알 수 없는 오류'} (${response.status}${code ? `, ${code}` : ''})`;
}

/**
 * 워드프레스 REST API 호출.
 * @param {string} route  '/wp/v2/posts' 처럼 wp-json 아래 경로
 */
export async function request(route, {
  method = 'GET',
  body,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT,
  signal,
} = {}) {
  const { site, auth } = credentials();
  const url = `${site}/wp-json${route}`;

  const init = {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...headers },
    signal: signal || AbortSignal.timeout(timeoutMs),
  };

  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`워드프레스가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다: ${url}`);
    }
    throw new Error(
      `워드프레스에 연결하지 못했습니다 (${url}): ${error.cause?.message || error.message}. `
      + '주소와 인터넷 연결, https 인증서를 확인해 주세요.',
    );
  }

  const parsed = await readBody(response);
  if (!response.ok) {
    const error = new Error(explain(response, parsed, url));
    error.status = response.status;
    error.code = parsed.json?.code || '';
    error.data = parsed.json?.data;
    throw error;
  }
  return parsed.json;
}

/* ------------------------------------------------------------------ */
/* 연결 상태                                                            */
/* ------------------------------------------------------------------ */

export function readSiteInfo() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  } catch {
    return { connected: false };
  }
}

function writeSiteInfo(info) {
  ensureDirs();
  fs.writeFileSync(SITE_FILE, JSON.stringify(info, null, 2), 'utf8');
  push('site', info);
  return info;
}

/**
 * 사이트 주소와 계정이 실제로 통하는지 확인한다.
 * 주제를 100개 돌리기 전에 여기서 한 번 걸러진다.
 */
export async function verifyConnection() {
  const settings = getSettings();
  const site = normalizeSiteUrl(settings.site.url);

  if (!site || !settings.site.username || !settings.site.appPassword) {
    return writeSiteInfo({
      connected: false,
      message: '사이트 주소, 사용자 이름, 응용 프로그램 비밀번호를 모두 입력해 주세요.',
      checkedAt: nowIso(),
    });
  }

  if (!/^https:/i.test(site) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(site)) {
    logger.warn(
      'https 가 아닌 주소입니다. 워드프레스는 기본적으로 https 사이트에서만 '
      + '응용 프로그램 비밀번호를 허용합니다. 인증이 실패하면 이 점을 먼저 확인하세요.',
    );
  }

  // 사이트 이름은 인증 없이도 읽히는 정보다. 주소가 맞는지 먼저 확인한다.
  let siteName = '';
  try {
    const root = await request('/', { timeoutMs: 20000 });
    siteName = String(root?.name || '');
  } catch (error) {
    return writeSiteInfo({
      connected: false, site, message: error.message, checkedAt: nowIso(),
    });
  }

  let me;
  try {
    me = await request('/wp/v2/users/me?context=edit');
  } catch (error) {
    return writeSiteInfo({
      connected: false, site, siteName, message: error.message, checkedAt: nowIso(),
    });
  }

  // 글을 쓸 수 있는 권한인지까지 본다. 구독자 계정이면 여기서 드러난다.
  const canPublish = Boolean(me?.capabilities?.publish_posts || me?.capabilities?.edit_posts);
  const info = {
    connected: true,
    site,
    siteName,
    userId: me?.id || 0,
    userName: me?.name || settings.site.username,
    roles: Array.isArray(me?.roles) ? me.roles : [],
    canPublish,
    message: canPublish ? '' : '이 계정에는 글쓰기 권한이 없습니다. 기여자 이상 권한이 필요합니다.',
    checkedAt: nowIso(),
  };
  writeSiteInfo(info);
  logger.info(
    `워드프레스 연결 확인: ${siteName || site} · ${info.userName}`
    + `${info.roles.length ? ` (${info.roles.join(', ')})` : ''}`,
  );
  return info;
}

/** 저장된 연결 정보를 지운다. 설정의 비밀번호도 함께 비운다. */
export function disconnect() {
  fs.rmSync(SITE_FILE, { force: true });
  saveSettings({ site: { appPassword: '' } });
  const info = { connected: false, checkedAt: nowIso() };
  push('site', info);
  logger.info('저장된 워드프레스 연결 정보를 지웠습니다.');
  return info;
}

/* ------------------------------------------------------------------ */
/* 분류(카테고리 / 태그)                                                */
/* ------------------------------------------------------------------ */

export async function listCategories() {
  const list = await request('/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=id,name,count');
  return (Array.isArray(list) ? list : []).map((item) => ({
    id: item.id, name: item.name, count: item.count || 0,
  }));
}

/**
 * 태그 이름을 ID 로 바꾼다. 없으면 새로 만든다.
 * 워드프레스는 태그도 분류 체계라서 이름만으로는 글에 붙일 수 없다.
 */
export async function ensureTags(names) {
  const ids = [];
  for (const raw of names) {
    const name = String(raw).trim().slice(0, 60);
    if (!name) continue;
    try {
      const found = await request(
        `/wp/v2/tags?per_page=20&search=${encodeURIComponent(name)}&_fields=id,name`,
      );
      const exact = (Array.isArray(found) ? found : [])
        .find((tag) => String(tag.name).toLowerCase() === name.toLowerCase());
      if (exact) {
        ids.push(exact.id);
        continue;
      }
      const created = await request('/wp/v2/tags', { method: 'POST', body: { name } });
      if (created?.id) ids.push(created.id);
    } catch (error) {
      // 같은 이름이 동시에 만들어진 경우 워드프레스가 기존 ID 를 알려준다.
      const existing = error.data?.term_id;
      if (existing) {
        ids.push(existing);
        continue;
      }
      logger.warn(`태그 "${name}" 를 등록하지 못해 건너뜁니다: ${error.message}`);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* 미디어                                                              */
/* ------------------------------------------------------------------ */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * 썸네일 PNG 를 미디어 라이브러리에 올린다.
 * @returns {Promise<{id:number, url:string}>}
 */
export async function uploadMedia(filePath, { title = '', alt = '' } = {}) {
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const type = MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream';

  const media = await request('/wp/v2/media', {
    method: 'POST',
    body: buffer,
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
    timeoutMs: 120000,          // 이미지 업로드는 오래 걸릴 수 있다.
  });

  if (!media?.id) throw new Error('이미지를 올렸지만 미디어 ID 를 받지 못했습니다.');

  // 대체 텍스트는 접근성과 SEO 에 쓰인다. 업로드와 한 번에는 못 넣어서 따로 채운다.
  if (title || alt) {
    try {
      await request(`/wp/v2/media/${media.id}`, {
        method: 'POST',
        body: { title: title || fileName, alt_text: alt || title },
      });
    } catch (error) {
      logger.warn(`이미지 설명을 채우지 못했습니다(글에는 영향 없음): ${error.message}`);
    }
  }

  return { id: media.id, url: media.source_url || media.guid?.rendered || '' };
}

/* ------------------------------------------------------------------ */
/* 글                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 초안(임시저장)으로 글을 올린다.
 *
 * 이 프로그램은 **절대 발행하지 않는다.** status 는 항상 'draft' 다.
 * 혹시라도 다른 값이 흘러 들어오면 여기서 막는다.
 * (블로거판에서 [저장]과 [게시] 버튼을 구분하던 장치와 같은 역할이다.)
 */
export async function createDraft({
  title, content, excerpt, slug, tagIds = [], categoryId = 0, featuredMediaId = 0, signal,
}) {
  const body = {
    title,
    content,
    status: 'draft',
    comment_status: 'open',
  };
  if (excerpt) body.excerpt = excerpt;
  if (slug) body.slug = slug;
  if (tagIds.length) body.tags = tagIds;
  if (categoryId) body.categories = [categoryId];
  if (featuredMediaId) body.featured_media = featuredMediaId;

  if (body.status !== 'draft') {
    throw new Error('안전장치: 이 프로그램은 임시저장만 합니다. 발행은 사람이 직접 하세요.');
  }

  const created = await request('/wp/v2/posts', { method: 'POST', body, timeoutMs: 120000, signal });
  if (!created?.id) throw new Error('글을 저장했지만 글 ID 를 받지 못했습니다.');

  if (created.status !== 'draft') {
    logger.warn(
      `워드프레스가 글 상태를 '${created.status}' 로 저장했습니다. `
      + '관리자에서 상태를 확인해 주세요.',
    );
  }

  const { site } = credentials();
  return {
    id: created.id,
    status: created.status,
    editUrl: `${site}/wp-admin/post.php?post=${created.id}&action=edit`,
    previewUrl: created.link || '',
  };
}
