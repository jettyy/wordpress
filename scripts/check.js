/**
 * 자체 점검 스크립트 (npm run check).
 *
 * AI 호출도, 워드프레스 연결도 없이 글 처리 파이프라인만 돌려본다.
 *   - 준수 검사기가 통과할 글을 통과시키고, 어긋난 글을 정확히 잡아내는지
 *   - 구텐베르크 블록 주석이 짝이 맞는지 (안 맞으면 에디터에 "블록 복구" 경고가 뜬다)
 *   - 마크다운 표가 제대로 나오는지
 *
 * 코드를 고친 뒤 여기부터 돌려보면 주제 100개를 태우기 전에 문제가 드러난다.
 */
import assert from 'node:assert/strict';
import { checkCompliance, countChars, buildRuleBlock } from '../src/content/adsense.js';
import { buildPostContent, buildPreviewHtml } from '../src/content/gutenberg.js';
import { buildMarkdown } from '../src/content/markdown.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { detectShape } from '../src/content/ranking.js';
import { normalizeSiteUrl, normalizeSlug, parseTopics } from '../src/lib/util.js';

const settings = structuredClone(DEFAULT_SETTINGS);

/** 규칙을 모두 지킨 글. 분량은 문단을 늘려 채운다. */
function buildSamplePost() {
  const long = (seed) => [
    `${seed}에 대해 알아두면 실제로 도움이 되는 내용을 정리했습니다.`,
    '준비 기간과 비용은 개인의 상황에 따라 달라지므로 범위로만 이해하시는 편이 좋습니다.',
    '실제로 준비해 본 사람들의 이야기를 모아 보면 공통적으로 언급되는 지점이 있습니다.',
    '무턱대고 시작하기보다 본인의 목표와 일정에 맞는지 먼저 따져 보시기 바랍니다.',
  ].join(' ');

  const subsection = (heading, seed) => ({
    heading,
    paragraphs: [long(seed), long(`${seed} 추가 설명`)],
    list: heading === '실제 활용 분야'
      ? ['제조와 건설 현장에서 꾸준히 수요가 있습니다.', '공공기관 채용에서도 가점 요소로 쓰입니다.']
      : [],
  });

  const item = (rank, name) => ({
    heading: `${rank}위. ${name}`,
    isItem: true,
    paragraphs: [long(name)],
    list: [],
    quote: '',
    subsections: [
      subsection('상세 설명', name),
      subsection('자격 요건과 난이도', name),
      subsection('실제 활용 분야', name),
      subsection('장점과 단점', name),
      subsection('준비 팁', name),
    ],
  });

  return {
    topic: '2026년 취업률 높은 국가기술자격증 TOP 3',
    shape: 'items',
    title: '2026년 취업률 높은 국가기술자격증 TOP 3 정리',
    slug: 'top-3-technical-certificates-2026',
    summary: '취업률과 활용성을 기준으로 자격증 세 가지를 정리했습니다.',
    guideline: '',
    guidelineCheck: '',
    tags: ['자격증', '취업준비', '국가기술자격'],
    thumbnail: {
      headline: '국가기술자격증 TOP 3', subline: '취업률 기준으로 정리했습니다',
      badge: '자격증', emoji: '', style: 'minimal', accent: '#16324F',
    },
    intro: [
      '자격증을 하나 따려고 마음먹었는데 무엇부터 봐야 할지 막막하신 분이 많습니다.',
      long('자격증 선택'),
    ],
    criteria: {
      heading: '추천 자격증을 고른 세 가지 기준',
      paragraphs: [long('선정 기준'), long('기준을 정한 이유')],
      items: [
        '취업률: 최근 채용 공고에서 얼마나 자주 요구되는지를 보았습니다.',
        '활용성: 특정 업종에만 쓰이는지, 여러 산업에서 통용되는지를 따졌습니다.',
        '난이도: 비전공자가 현실적으로 도전할 수 있는 수준인지 확인했습니다.',
      ],
    },
    table: {
      heading: '한눈에 보는 비교표',
      headers: ['구분', '자격증', '핵심 활용 분야', '난이도'],
      rows: [
        ['1', '전기기사', '전력 설비와 시공 관리', '높음'],
        ['2', '산업안전기사', '안전 관리자 선임', '보통'],
        ['3', '정보처리기사', '소프트웨어 개발과 공공 입찰', '보통'],
      ],
      note: '이 표는 공식 순위가 아니라 일반적으로 알려진 정보를 정리한 참고 자료이며, 최신 정보는 직접 확인하시기 바랍니다.',
    },
    sections: [item(1, '전기기사'), item(2, '산업안전기사'), item(3, '정보처리기사')],
    faq: [
      { question: '비전공자도 응시할 수 있습니까?', answer: long('응시 자격') },
      { question: '준비 기간은 얼마나 걸립니까?', answer: long('준비 기간') },
    ],
    outro: [long('마무리 요약'), '오늘 정리한 기준을 참고해 본인에게 맞는 자격증부터 차근차근 준비해 보시기 바랍니다.'],
    model: 'claude-sonnet-5',
    costUsd: 0,
    compliance: null,
    repairs: 0,
  };
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  통과  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  실패  ${name}\n        ${error.message}`);
  }
}

console.log('\n[1] 준수 검사기');

test('규칙을 지킨 글은 모든 항목을 통과한다', () => {
  const result = checkCompliance(buildSamplePost(), settings);
  assert.equal(result.ok, true, `미통과: ${result.issues.map((i) => `${i.label}(${i.detail})`).join(', ')}`);
  assert.ok(result.charCount >= settings.post.minChars, `분량 ${result.charCount}자`);
});

test('분량이 모자라면 length 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.sections = post.sections.slice(0, 1);
  post.sections[0].subsections = post.sections[0].subsections.slice(0, 3);
  post.criteria.paragraphs = ['짧습니다.'];
  post.faq = [];
  post.intro = ['짧은 도입입니다.'];
  post.outro = ['짧은 마무리입니다. 그래도 두 문장은 씁니다.'];
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'length'), '분량 미달을 못 잡았습니다');
});

test('개조식("~함") 문장을 잡아낸다', () => {
  const post = buildSamplePost();
  post.sections[0].paragraphs = ['전기기사는 전력 설비를 다루는 자격증임. 수요가 꾸준함.'];
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'ending'), '개조식을 못 잡았습니다');
});

test('해요체만 쓰면 종결어미 규칙이 걸린다', () => {
  const post = buildSamplePost();
  const rewrite = (list) => list.map(() => '이런 부분은 꼭 확인해 보세요. 생각보다 중요해요. 놓치면 손해예요.');
  post.intro = rewrite(post.intro);
  post.outro = rewrite(post.outro);
  post.criteria.paragraphs = rewrite(post.criteria.paragraphs);
  for (const section of post.sections) {
    section.paragraphs = rewrite(section.paragraphs);
    for (const sub of section.subsections) sub.paragraphs = rewrite(sub.paragraphs);
  }
  post.faq = post.faq.map((item) => ({ ...item, answer: '이렇게 하면 돼요. 어렵지 않아요.' }));
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'ending'), '해요체를 못 잡았습니다');
});

test('표가 없으면 table 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.table = null;
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'table'), '표 누락을 못 잡았습니다');
});

test('인사말로 시작하면 opening 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.intro[0] = '안녕하세요. 이번 포스팅에서는 자격증에 대해 알아보겠습니다.';
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'opening'), '인사말을 못 잡았습니다');
});

test('특수문자와 이모지를 잡아낸다', () => {
  const post = buildSamplePost();
  post.sections[0].heading = '1위. 전기기사 ★ 강력 추천';
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'symbols'), '특수문자를 못 잡았습니다');

  const emojiPost = buildSamplePost();
  emojiPost.intro[0] = '자격증을 고르기가 막막하신가요 🙂 함께 정리해 보겠습니다.';
  assert.ok(
    checkCompliance(emojiPost, settings).issues.some((issue) => issue.id === 'symbols'),
    '이모지를 못 잡았습니다',
  );
});

test('선정 기준이 비면 criteria 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.criteria = null;
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'criteria'), '선정 기준 누락을 못 잡았습니다');
});

test('항목 섹션의 세부 소제목이 부족하면 detail 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.sections[1].subsections = post.sections[1].subsections.slice(0, 1);
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'detail'), '얕은 항목을 못 잡았습니다');
});

test('불렛 포인트가 없으면 bullets 규칙이 걸린다', () => {
  const post = buildSamplePost();
  for (const section of post.sections) {
    section.list = [];
    for (const sub of section.subsections) sub.list = [];
  }
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'bullets'), '목록 누락을 못 잡았습니다');
});

test('규칙 지시문에 모든 규칙이 들어간다', () => {
  const block = buildRuleBlock(settings, 'items');
  for (const label of ['분량', '종결어미', '소제목 구조', '선정 기준', '비교 표', '불렛 포인트', '항목별 상세']) {
    assert.ok(block.includes(label), `"${label}" 규칙이 프롬프트에 없습니다`);
  }
});

console.log('\n[2] 구텐베르크 블록');

test('블록 주석의 짝이 맞는다', () => {
  const content = buildPostContent(buildSamplePost(), '', { moreTag: true });
  const opens = content.match(/<!-- wp:([a-z-]+)(?: |-->)/g) || [];
  const closes = content.match(/<!-- \/wp:([a-z-]+) -->/g) || [];
  // more 블록은 여는 주석과 닫는 주석이 하나씩이므로 개수가 같아야 한다.
  // (self-closing 블록은 쓰지 않는다)
  assert.equal(opens.length, closes.length, `여는 주석 ${opens.length}개, 닫는 주석 ${closes.length}개`);
});

test('필요한 블록이 모두 들어간다', () => {
  const content = buildPostContent(buildSamplePost(), '', { moreTag: true });
  for (const block of ['wp:paragraph', 'wp:heading', 'wp:list', 'wp:table', 'wp:more', 'wp:separator']) {
    assert.ok(content.includes(`<!-- ${block}`), `${block} 블록이 없습니다`);
  }
  assert.ok(content.includes('<h2 class="wp-block-heading">'), 'H2 가 없습니다');
  assert.ok(content.includes('<h3 class="wp-block-heading">'), 'H3 가 없습니다');
  assert.ok(!content.includes('<h1'), '본문에 H1 이 들어갔습니다 (제목이 이미 H1 입니다)');
});

test('이미지 블록과 더 읽기 순서가 도입부 뒤에 온다', () => {
  const image = '<!-- wp:image {"id":9} -->\n<figure class="wp-block-image size-large">'
    + '<img src="https://x/y.png" alt="t" class="wp-image-9"/></figure>\n<!-- /wp:image -->';
  const content = buildPostContent(buildSamplePost(), image, { moreTag: true });
  assert.ok(content.indexOf('wp:image') < content.indexOf('wp:more'), '이미지가 더 읽기 뒤에 있습니다');
  assert.ok(content.indexOf('wp:more') < content.indexOf('wp:table'), '더 읽기가 표 뒤에 있습니다');
});

test('<b> 강조는 <strong> 으로 바뀌고 다른 태그는 막힌다', () => {
  const post = buildSamplePost();
  post.intro[0] = '이 부분은 <b>정말 중요합니다</b>. <script>alert(1)</script> 는 들어가면 안 됩니다.';
  const content = buildPostContent(post, '', { moreTag: false });
  assert.ok(content.includes('<strong>정말 중요합니다</strong>'), '강조가 변환되지 않았습니다');
  assert.ok(!content.includes('<script>'), '스크립트 태그가 그대로 들어갔습니다');
});

test('미리보기 HTML 에 준수 점검 결과가 들어간다', () => {
  const post = buildSamplePost();
  post.compliance = checkCompliance(post, settings);
  const html = buildPreviewHtml(post, buildPostContent(post, '', {}));
  assert.ok(html.includes('애드센스 준수 점검'), '점검 결과가 미리보기에 없습니다');
});

console.log('\n[3] 마크다운');

test('H1 하나, H2/H3 소제목, 표가 들어간다', () => {
  const markdown = buildMarkdown(buildSamplePost());
  const h1 = markdown.split('\n').filter((line) => /^# /.test(line));
  assert.equal(h1.length, 1, `H1 이 ${h1.length}개입니다`);
  assert.ok(markdown.includes('\n## '), 'H2 가 없습니다');
  assert.ok(markdown.includes('\n### '), 'H3 가 없습니다');
  assert.ok(/\n\| 구분 \| 자격증 \|/.test(markdown), '표가 없습니다');
  assert.ok(markdown.includes('\n- '), '불렛 포인트가 없습니다');
});

console.log('\n[4] 보조 함수');

test('주제 문자열에서 글의 모양을 알아낸다', () => {
  assert.equal(detectShape('국가기술자격증 TOP 5').shape, 'items');
  assert.equal(detectShape('자격증 7가지 추천').count, 7);
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').shape, 'table');
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').needsChunking, true);
  assert.equal(detectShape('전세 계약 전 확인할 서류').shape, 'general');
});

test('사이트 주소의 꼬리를 떼어낸다', () => {
  assert.equal(normalizeSiteUrl('myblog.com/wp-admin/'), 'https://myblog.com');
  assert.equal(normalizeSiteUrl('https://myblog.com/wp-json/'), 'https://myblog.com');
  assert.equal(normalizeSiteUrl('http://localhost:8080/'), 'http://localhost:8080');
});

test('슬러그를 주소에 쓸 수 있는 형태로 다듬는다', () => {
  assert.equal(normalizeSlug('Top 5 Technical! Certificates'), 'top-5-technical-certificates');
});

test('엑셀에서 붙여넣은 주제를 줄 단위로 읽는다', () => {
  const topics = parseTopics('주제\n자격증 TOP 5\t비고\n자격증 TOP 5\n\n전세 계약 서류');
  assert.deepEqual(topics, ['자격증 TOP 5', '전세 계약 서류']);
});

test('countChars 는 공백을 빼고 센다', () => {
  assert.equal(countChars({ intro: ['가 나 다'], sections: [], outro: [] }), 3);
});

console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
