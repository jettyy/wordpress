import path from 'node:path';
import fs from 'node:fs';
import { renderTemplate } from './templates/index.js';
import { getRenderBrowser } from '../lib/playwright.js';
import { getSettings } from '../lib/settings.js';
import { THUMB_DIR, ensureDirs } from '../lib/paths.js';
import { slugify } from '../lib/util.js';
import { logger } from '../lib/events.js';
import { maybeGenerateImage } from './imagegen.js';

/**
 * AI 가 설계한 문구/색상을 HTML 템플릿에 얹고 스크린샷으로 PNG를 만든다.
 * 이미지 생성 API를 쓰지 않으므로 추가 비용이 없다.
 */
/** data:image/png;base64,... 를 파일로 떨군다. */
function saveDataUri(dataUri, jobId, title) {
  const match = /^data:image\/([a-z]+);base64,(.+)$/i.exec(dataUri);
  if (!match) throw new Error('이미지 데이터를 읽지 못했습니다.');
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const fileName = `${Date.now()}-${jobId || slugify(title, 24)}.${ext}`;
  const filePath = path.join(THUMB_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return { filePath, fileName };
}

export async function renderThumbnail(post, { jobId = '', signal } = {}) {
  ensureDirs();
  const settings = getSettings();
  const { width, height } = settings.thumbnail;

  // 이미지 API 에 맡기는 부분.
  //   full    — 글자까지 그린 완성 썸네일이 온다. 그대로 쓴다.
  //   overlay — 글자 없는 배경만 온다. 아래에서 브라우저가 한글을 얹는다.
  // 꺼져 있거나 실패하면 null 이 오고, HTML 썸네일로 그대로 진행한다.
  const generated = await maybeGenerateImage(post.thumbnail, {
    signal, width, height, jobId,
  });

  if (generated?.mode === 'full') {
    // 완성본이라 브라우저를 띄울 이유가 없다. 받은 그림을 그대로 저장한다.
    const { filePath, fileName } = saveDataUri(generated.dataUri, jobId, post.title);
    const size = fs.statSync(filePath).size;
    logger.info(`썸네일 저장 완료 (API 완성본, ${Math.round(size / 1024)}KB)`, { jobId });
    return { filePath, fileName, style: 'api', generated: true, mode: 'full' };
  }

  const background = generated;
  const spec = {
    ...post.thumbnail,
    // 애드센스 글은 기호를 자제하는 편이 안전하다. 설정에서 켤 때만 넣는다.
    emoji: settings.thumbnail.emoji ? post.thumbnail.emoji : '',
    background: background?.dataUri || '',
    width,
    height,
  };
  const html = renderTemplate(spec);

  const browser = await getRenderBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,          // 워드프레스 대표 이미지로 써도 흐려지지 않게 2배로 뽑는다.
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // 웹폰트를 기다리되, 네트워크가 막혀 있으면 로컬 폰트로 그냥 진행한다.
    await page
      .evaluate(() => Promise.race([
        document.fonts?.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]))
      .catch(() => {});
    await page.waitForTimeout(250);

    const fileName = `${Date.now()}-${jobId || slugify(post.title, 24)}.png`;
    const filePath = path.join(THUMB_DIR, fileName);
    await page.screenshot({ path: filePath, type: 'png' });

    const size = fs.statSync(filePath).size;
    const layout = spec.background ? '배경 그림 + 문구' : spec.style;
    logger.info(`썸네일 생성 완료 (${layout}, ${Math.round(size / 1024)}KB)`, { jobId });
    return {
      filePath, fileName, style: spec.style,
      generated: Boolean(spec.background), mode: 'overlay',
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/** 대시보드 미리보기용 — 저장하지 않고 HTML만 돌려준다. */
export function previewThumbnailHtml(spec) {
  const settings = getSettings();
  return renderTemplate({
    headline: spec.headline || '썸네일 미리보기',
    subline: spec.subline || '주제에 맞춰 AI가 문구를 만듭니다',
    badge: spec.badge || '정보 정리',
    emoji: settings.thumbnail.emoji ? (spec.emoji || '') : '',
    accent: /^#[0-9a-f]{6}$/i.test(spec.accent || '') ? spec.accent : '#16324F',
    style: spec.style && spec.style !== 'auto' ? spec.style : 'minimal',
    width: settings.thumbnail.width,
    height: settings.thumbnail.height,
  });
}
