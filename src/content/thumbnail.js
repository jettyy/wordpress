import path from 'node:path';
import fs from 'node:fs';
import { renderTemplate } from './templates/index.js';
import { getRenderBrowser } from '../lib/playwright.js';
import { getSettings } from '../lib/settings.js';
import { THUMB_DIR, ensureDirs } from '../lib/paths.js';
import { slugify } from '../lib/util.js';
import { logger } from '../lib/events.js';
import { maybeGenerateBackground } from './imagegen.js';

/**
 * AI 가 설계한 문구/색상을 HTML 템플릿에 얹고 스크린샷으로 PNG를 만든다.
 * 이미지 생성 API를 쓰지 않으므로 추가 비용이 없다.
 */
export async function renderThumbnail(post, { jobId = '', signal } = {}) {
  ensureDirs();
  const settings = getSettings();
  const { width, height } = settings.thumbnail;

  // 배경 그림은 이미지 API 가 그리고(글자 없이), 한글 문구는 아래에서 브라우저가 얹는다.
  // 꺼져 있거나 실패하면 null 이 오고, 기존 단색 썸네일로 그대로 진행한다.
  const background = await maybeGenerateBackground(post.thumbnail, {
    signal, width, height, jobId,
  });

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
    return { filePath, fileName, style: spec.style, generated: Boolean(spec.background) };
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
