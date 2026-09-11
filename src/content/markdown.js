/**
 * 같은 글을 마크다운으로도 뽑아 둔다.
 *
 * 애드센스 승인글 요구사항의 [출력 형식] 이 "구텐베르크 편집기에 바로 붙여넣을 수 있는
 * 깔끔한 마크다운" 이기 때문이다. 자동 저장이 실패해도 이 파일만 열어
 * 블록 에디터에 통째로 붙여넣으면 표와 소제목이 그대로 들어간다.
 *
 * H1 은 글 제목 하나뿐이고, 소제목은 H2/H3 로만 쓴다.
 */

/** 마크다운 표에서 셀 구분자로 오해받는 문자를 막는다. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** <b> 강조는 마크다운 굵게로 바꾼다. */
function inline(text) {
  return String(text ?? '')
    .replace(/<\s*b\s*>/gi, '**')
    .replace(/<\s*\/\s*b\s*>/gi, '**')
    .replace(/<\s*strong\s*>/gi, '**')
    .replace(/<\s*\/\s*strong\s*>/gi, '**')
    .trim();
}

function tableMarkdown(table) {
  if (!table?.headers?.length || !table.rows?.length) return [];
  const lines = [];
  if (table.heading) lines.push(`### ${inline(table.heading)}`, '');
  lines.push(`| ${table.headers.map(cell).join(' | ')} |`);
  lines.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
  for (const row of table.rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  lines.push('');
  if (table.note) lines.push(`> ${inline(table.note)}`, '');
  return lines;
}

export function buildMarkdown(post, { thumbnailFile = '' } = {}) {
  const lines = [`# ${inline(post.title)}`, ''];

  post.intro.forEach((text) => lines.push(inline(text), ''));

  if (thumbnailFile) lines.push(`![${inline(post.title)}](${thumbnailFile})`, '');

  if (post.criteria) {
    lines.push(`## ${inline(post.criteria.heading)}`, '');
    post.criteria.paragraphs.forEach((text) => lines.push(inline(text), ''));
    if (post.criteria.items?.length) {
      post.criteria.items.forEach((item) => lines.push(`- ${inline(item)}`));
      lines.push('');
    }
  }

  lines.push(...tableMarkdown(post.table));

  for (const section of post.sections) {
    if (section.heading) lines.push(`## ${inline(section.heading)}`, '');
    section.paragraphs.forEach((text) => lines.push(inline(text), ''));
    if (section.list?.length) {
      section.list.forEach((item) => lines.push(`- ${inline(item)}`));
      lines.push('');
    }
    for (const sub of section.subsections || []) {
      lines.push(`### ${inline(sub.heading)}`, '');
      sub.paragraphs.forEach((text) => lines.push(inline(text), ''));
      if (sub.list?.length) {
        sub.list.forEach((item) => lines.push(`- ${inline(item)}`));
        lines.push('');
      }
    }
    if (section.quote) lines.push(`> ${inline(section.quote)}`, '');
  }

  if (post.faq?.length) {
    lines.push('## 자주 묻는 질문', '');
    for (const item of post.faq) {
      lines.push(`### ${inline(item.question)}`, '');
      lines.push(inline(item.answer), '');
    }
  }

  post.outro.forEach((text) => lines.push(inline(text), ''));

  // 연속된 빈 줄을 하나로 줄여 깔끔하게 끝낸다.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
