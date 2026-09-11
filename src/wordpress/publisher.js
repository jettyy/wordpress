import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { buildPostContent, buildImageBlock } from '../content/gutenberg.js';
import { uploadMedia, ensureTags, createDraft } from './client.js';

/**
 * 글 하나를 워드프레스에 임시저장한다.
 *
 * 순서가 중요하다.
 *  1) 썸네일을 먼저 올려 미디어 ID 를 받는다 (본문 이미지 블록에 그 ID 가 들어가야
 *     에디터가 미디어 라이브러리의 파일과 연결한다)
 *  2) 그 이미지 블록을 끼워 본문 마크업을 완성한다
 *  3) 태그 이름을 ID 로 바꾼다
 *  4) 초안으로 저장한다 (발행은 하지 않는다)
 *
 * 중간 단계가 실패해도 글 자체는 저장되도록 설계했다.
 * 이미지가 안 올라갔다고 1,800자짜리 글을 버릴 이유는 없다.
 */
export async function saveDraft({ post, thumbnailPath, jobId = '', signal }) {
  const settings = getSettings();

  /* 1. 썸네일 업로드 ------------------------------------------------ */
  let media = null;
  const wantsImage = thumbnailPath && (settings.thumbnail.insert || settings.thumbnail.featured);
  if (wantsImage) {
    try {
      media = await uploadMedia(thumbnailPath, { title: post.title, alt: post.title });
      logger.info(`썸네일을 미디어 라이브러리에 올렸습니다. (미디어 ID ${media.id})`, { jobId });
    } catch (error) {
      logger.warn(`썸네일 업로드에 실패해 글만 저장합니다: ${error.message}`, { jobId });
    }
  }

  /* 2. 본문 조립 ---------------------------------------------------- */
  const imageBlock = media && settings.thumbnail.insert
    ? buildImageBlock({ id: media.id, url: media.url, alt: post.title })
    : '';

  const content = buildPostContent(post, imageBlock, { moreTag: settings.post.moreTag });

  /* 3. 태그 --------------------------------------------------------- */
  let tagIds = [];
  if (settings.post.applyTags && post.tags?.length) {
    try {
      tagIds = await ensureTags(post.tags);
      if (tagIds.length) logger.info(`태그 ${tagIds.length}개를 붙였습니다.`, { jobId });
    } catch (error) {
      logger.warn(`태그를 붙이지 못해 건너뜁니다: ${error.message}`, { jobId });
    }
  }

  /* 4. 초안 저장 ----------------------------------------------------- */
  const result = await createDraft({
    title: post.title,
    content,
    excerpt: post.summary,
    slug: post.slug,
    tagIds,
    categoryId: Number(settings.site.categoryId) || 0,
    featuredMediaId: media && settings.thumbnail.featured ? media.id : 0,
    signal,
  });

  return {
    ...result,
    content,
    mediaId: media?.id || 0,
    tagIds,
  };
}
