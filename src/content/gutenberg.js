import { escapeHtml } from '../lib/util.js';

/**
 * 글 데이터를 **구텐베르크 블록 마크업**으로 바꾼다.
 *
 * 블로거판은 인라인 style 을 박은 HTML 을 만들었지만, 워드프레스는 다르다.
 * 여기서 만든 마크업은 블록 에디터가 그대로 읽어 "문단 블록", "표 블록" 으로
 * 인식하고, 색과 여백은 테마가 알아서 입힌다. 그래서
 *
 *   - 인라인 style 을 쓰지 않는다 (테마와 싸우게 된다)
 *   - 블록 주석(<!-- wp:... -->)을 정확히 짝 맞춰 넣는다 (깨지면 "블록 복구" 경고가 뜬다)
 *   - 소제목은 H2/H3 만 쓴다 (글 제목이 이미 H1 이다)
 */

/** AI 는 문단 안에서 <b> 만 쓰도록 지시받는다. 나머지 태그 주입은 막는다. */
function inline(text) {
  return escapeHtml(text)
    .replace(/&lt;b&gt;/gi, '<strong>')
    .replace(/&lt;\/b&gt;/gi, '</strong>')
    .replace(/&lt;strong&gt;/gi, '<strong>')
    .replace(/&lt;\/strong&gt;/gi, '</strong>');
}

function paragraph(text) {
  return `<!-- wp:paragraph -->\n<p>${inline(text)}</p>\n<!-- /wp:paragraph -->`;
}

function heading(text, level = 2) {
  const attrs = level === 2 ? '' : ` {"level":${level}}`;
  return `<!-- wp:heading${attrs} -->\n`
    + `<h${level} class="wp-block-heading">${inline(text)}</h${level}>\n`
    + '<!-- /wp:heading -->';
}

/**
 * @param {boolean} raw  항목이 이미 안전한 HTML 일 때만 true.
 *                       (출처 목록의 <a> 링크. 그 외에는 전부 이스케이프한다)
 */
function list(items, raw = false) {
  const li = items
    .map((item) => `<!-- wp:list-item -->\n<li>${raw ? item : inline(item)}</li>\n<!-- /wp:list-item -->`)
    .join('\n');
  return `<!-- wp:list -->\n<ul class="wp-block-list">${li}</ul>\n<!-- /wp:list -->`;
}

function quote(text) {
  return '<!-- wp:quote -->\n'
    + `<blockquote class="wp-block-quote">${paragraph(text)}</blockquote>\n`
    + '<!-- /wp:quote -->';
}

export function separator() {
  return '<!-- wp:separator -->\n'
    + '<hr class="wp-block-separator has-alpha-channel-opacity"/>\n'
    + '<!-- /wp:separator -->';
}

/** 워드프레스 목록 화면에 도입부까지만 보이게 하는 "더 읽기" 블록. */
export const MORE_BLOCK = '<!-- wp:more -->\n<!--more-->\n<!-- /wp:more -->';

/** 비교표. 구텐베르크 표 블록이라 에디터에서 그대로 수정할 수 있다. */
export function buildTableBlock(table) {
  if (!table?.headers?.length || !table.rows?.length) return '';

  const th = table.headers.map((header) => `<th>${inline(header)}</th>`).join('');
  const trs = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('');
  const caption = table.note
    ? `<figcaption class="wp-element-caption">${inline(table.note)}</figcaption>`
    : '';

  return '<!-- wp:table -->\n'
    + '<figure class="wp-block-table"><table class="has-fixed-layout">'
    + `<thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>${caption}</figure>\n`
    + '<!-- /wp:table -->';
}

/**
 * 업로드한 미디어를 이미지 블록으로 만든다.
 * id 를 넣어야 에디터가 미디어 라이브러리의 그 파일과 연결한다.
 */
export function buildImageBlock({ id, url, alt = '' }) {
  if (!url) return '';
  const attrs = JSON.stringify({
    ...(id ? { id } : {}),
    sizeSlug: 'large',
    linkDestination: 'none',
  });
  const className = id ? ` class="wp-image-${id}"` : '';
  return `<!-- wp:image ${attrs} -->\n`
    + `<figure class="wp-block-image size-large">`
    + `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${className}/></figure>\n`
    + '<!-- /wp:image -->';
}

function subsectionBlocks(sub) {
  const blocks = [heading(sub.heading, 3)];
  sub.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (sub.list?.length) blocks.push(list(sub.list));
  return blocks;
}

function sectionBlocks(section) {
  const blocks = [];
  if (section.heading) blocks.push(heading(section.heading, 2));
  section.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (section.list?.length) blocks.push(list(section.list));
  for (const sub of section.subsections || []) blocks.push(...subsectionBlocks(sub));
  if (section.quote) blocks.push(quote(section.quote));
  return blocks;
}

function criteriaBlocks(criteria) {
  if (!criteria) return [];
  const blocks = [heading(criteria.heading || '추천 항목을 고른 기준', 2)];
  criteria.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (criteria.items?.length) blocks.push(list(criteria.items));
  return blocks;
}

/**
 * 글 끝의 출처 목록.
 *
 * 애드센스 심사에서 "근거 있는 글" 로 보이게 하는 부분이고,
 * 읽는 사람이 원문을 직접 확인할 수 있게 해주는 장치이기도 하다.
 * URL 은 조사 단계에서 실제 검색 결과에 나온 것만 남겨둔 상태다.
 */
function sourcesBlocks(post, headingText) {
  if (!post.sources?.length) return [];

  const items = post.sources.map((source) => {
    const title = escapeHtml(source.title || source.url);
    const meta = [source.publisher, source.date]
      .filter(Boolean)
      .filter((part, index, all) => all.indexOf(part) === index)
      .join(', ');
    // rel 에 noopener 를 넣지 않으면 새 창이 원래 페이지를 조작할 수 있다.
    return `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      + (meta ? ` ${escapeHtml(`(${meta})`)}` : '');
  });

  return [
    heading(headingText || '참고 자료', 2),
    paragraph('아래 자료를 참고해 정리했습니다. 제도와 일정은 바뀔 수 있으니 '
      + '중요한 내용은 각 기관의 공식 공지에서 다시 확인하시기 바랍니다.'),
    list(items, true),
  ];
}

function faqBlocks(faq) {
  if (!faq?.length) return [];
  const blocks = [heading('자주 묻는 질문', 2)];
  for (const item of faq) {
    blocks.push(heading(item.question, 3));
    blocks.push(paragraph(item.answer));
  }
  return blocks;
}

/** 썸네일 앞에 들어갈 도입부만. */
export function buildIntroBlocks(post) {
  return post.intro.map(paragraph);
}

/**
 * 글 본문 전체를 구텐베르크 블록 마크업으로 만든다.
 *
 * 순서: 도입부 → 썸네일 → (더 읽기) → 선정 기준 → 비교표 → 본문 섹션
 *       → FAQ → 마무리 → 참고 자료
 *
 * 출처 목록을 맨 끝에 두는 이유는, 읽는 흐름을 끊지 않으면서도
 * 글이 무엇을 근거로 쓰였는지 확인할 수 있게 하기 위해서다.
 *
 * @param {object} post
 * @param {string} imageBlock  업로드된 썸네일의 이미지 블록 (없으면 빈 문자열)
 * @param {{moreTag?: boolean, sourcesHeading?: string}} options
 */
export function buildPostContent(post, imageBlock = '', { moreTag = true, sourcesHeading = '참고 자료' } = {}) {
  const blocks = [...buildIntroBlocks(post)];

  if (imageBlock) blocks.push(imageBlock);
  if (moreTag) blocks.push(MORE_BLOCK);

  blocks.push(...criteriaBlocks(post.criteria));

  const tableBlock = buildTableBlock(post.table);
  if (tableBlock) blocks.push(tableBlock);

  post.sections.forEach((section, index) => {
    if (index > 0) blocks.push(separator());
    blocks.push(...sectionBlocks(section));
  });

  const faq = faqBlocks(post.faq);
  if (faq.length) {
    blocks.push(separator());
    blocks.push(...faq);
  }

  if (post.outro.length) {
    blocks.push(separator());
    blocks.push(...post.outro.map(paragraph));
  }

  const sources = sourcesBlocks(post, sourcesHeading);
  if (sources.length) {
    blocks.push(separator());
    blocks.push(...sources);
  }

  return blocks.filter(Boolean).join('\n\n');
}

/**
 * 미리보기·백업용 단일 HTML 문서.
 * 블록 주석은 HTML 주석이라 브라우저가 무시하므로 그대로 열어 볼 수 있다.
 */
export function buildPreviewHtml(post, content) {
  const meta = [];
  if (post.guideline) {
    meta.push(`<b>적용된 추가 지침</b><br>${escapeHtml(post.guideline).replace(/\n/g, '<br>')}`);
  }
  if (post.guidelineCheck) meta.push(`<b>AI 자체 확인</b><br>${escapeHtml(post.guidelineCheck)}`);
  if (post.model) meta.push(`<b>사용 모델</b> ${escapeHtml(post.model)}`);
  if (post.tags?.length) meta.push(`<b>태그</b> ${escapeHtml(post.tags.join(', '))}`);

  // 발행 전에 사람이 확인해야 하는 부분이라 미리보기 맨 위에 올린다.
  if (post.research) {
    const research = post.research;
    const rows = [
      `검색 ${research.searches}회 · 사실 ${research.facts.length}건 · 출처 ${research.sources.length}건`,
    ];
    if (!research.searches) {
      rows.push('<b style="color:#b3302a;">웹 검색이 실제로 실행되지 않았습니다. '
        + '아래 내용은 검색 결과가 아닐 수 있으니 반드시 직접 확인하세요.</b>');
    }
    if (research.freshness) rows.push(`최신성: ${escapeHtml(research.freshness)}`);
    if (research.unverified?.length) {
      rows.push(`<b>확인하지 못한 내용</b><br>${research.unverified
        .map((item) => `- ${escapeHtml(item)}`).join('<br>')}`);
    }
    meta.push(`<b>자료 조사</b><br>${rows.join('<br>')}`);
  }
  if (post.compliance) {
    const rows = post.compliance.results
      .map((result) => `${result.ok ? '통과' : '미통과'} · ${escapeHtml(result.label)} — ${escapeHtml(result.detail)}`)
      .join('<br>');
    meta.push(
      `<b>애드센스 준수 점검 (${post.compliance.passed}/${post.compliance.total})</b><br>${rows}`,
    );
  }

  const metaBox = meta.length
    ? `<div style="margin:0 0 24px; padding:12px 16px; background:#f6f8fa; border-radius:8px;
         font-size:13px; color:#5b6773; line-height:1.8;">${meta.join('<br><br>')}</div>`
    : '';

  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(post.title)}</title>`,
    '<style>',
    'body{max-width:780px;margin:40px auto;padding:0 20px;',
    "font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#1a1a1a;line-height:1.9;}",
    'h1{font-size:30px;line-height:1.4;margin:0 0 24px;}',
    'h2{font-size:22px;margin:2em 0 .6em;}h3{font-size:17px;margin:1.6em 0 .5em;}',
    'table{border-collapse:collapse;width:100%;margin:1.2em 0;}',
    'th,td{border:1px solid #dfe3e8;padding:.55em .7em;font-size:.95em;}',
    'th{background:#f6f8fa;}figcaption{font-size:.85em;color:#7a8590;margin-top:.5em;}',
    'hr{border:0;border-top:1px solid #e6e8ea;margin:2.2em 0;}',
    'figure{margin:1.6em 0;}img{max-width:100%;}',
    '</style>',
    `<h1>${escapeHtml(post.title)}</h1>`,
    metaBox,
    content,
  ].join('\n');
}
