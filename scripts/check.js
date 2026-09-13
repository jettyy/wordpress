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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCompliance, countChars, buildRuleBlock } from '../src/content/adsense.js';
import { buildPostContent, buildPreviewHtml } from '../src/content/gutenberg.js';
import { buildMarkdown } from '../src/content/markdown.js';
import { DEFAULT_SETTINGS, saveSettings, getSettings, publicSettings } from '../src/lib/settings.js';
import { detectShape } from '../src/content/ranking.js';
import {
  buildImagePrompt, buildPosterPrompt, pickAspectRatio,
  looksLikeImageModel, rankImageModels, pickVisionModel, priceOf,
} from '../src/content/imagegen.js';
import { renderTemplate } from '../src/content/templates/index.js';
import { buildResearchBlock, isUsableUrl } from '../src/content/research.js';
import { normalizeSiteUrl, normalizeSlug, parseTopics } from '../src/lib/util.js';

const settings = structuredClone(DEFAULT_SETTINGS);

/**
 * 먼저 모든 모듈을 한 번씩 불러 본다.
 *
 * 아래 검사들은 일부 모듈만 import 하기 때문에, 손대지 않은 파일에
 * 오타나 문법 오류가 있어도 "모두 통과" 가 뜰 수 있다. 실제로 그런 적이 있다.
 * (server.js 는 부르면 서버가 떠버리므로 뺀다)
 */
async function loadEveryModule() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');
  const files = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'server.js') files.push(full);
    }
  };
  walk(srcDir);

  const broken = [];
  for (const file of files.sort()) {
    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      broken.push(`${path.relative(srcDir, file)}: ${error.message.split('\n')[0]}`);
    }
  }
  return { count: files.length, broken };
}

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

console.log('\n[0] 모듈 불러오기');

const modules = await loadEveryModule();
test(`src 아래 ${modules.count}개 모듈이 모두 열린다`, () => {
  assert.equal(modules.broken.length, 0, `\n        ${modules.broken.join('\n        ')}`);
});

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

console.log('\n[4] 자료 조사 · 출처');

const sampleSources = [
  { title: '국가기술자격 시행계획 공고', publisher: '한국산업인력공단', url: 'https://www.q-net.or.kr/notice/1234', date: '2026-01' },
  { title: '산업안전기사 응시 자격 안내', publisher: 'Q-net', url: 'https://www.q-net.or.kr/guide/safety', date: '2026-02' },
];

test('지어낸 주소와 자리표시자 주소를 걸러낸다', () => {
  assert.equal(isUsableUrl('https://www.q-net.or.kr/notice/1234'), true);
  assert.equal(isUsableUrl('http://localhost:8080/x'), false, 'localhost 를 통과시켰습니다');
  assert.equal(isUsableUrl('https://example.com/a'), false, '자리표시자 주소를 통과시켰습니다');
  assert.equal(isUsableUrl('출처: 한국산업인력공단'), false);
  assert.equal(isUsableUrl(''), false);
});

test('조사 자료 블록에 사실과 미확인 항목이 들어간다', () => {
  const block = buildResearchBlock({
    summary: '2026년 시행계획이 공고되었습니다.',
    freshness: '2026년 1월 공고 기준입니다.',
    items: ['산업안전기사'],
    facts: [{ claim: '제1회 필기시험은 1월 30일에 시작합니다.', detail: 'CBT 방식입니다.', source: 'Q-net', url: 'https://www.q-net.or.kr/notice/1234', date: '2026-01' }],
    sources: sampleSources,
    unverified: ['실기 합격률은 출처마다 달랐습니다.'],
  });
  assert.ok(block.includes('제1회 필기시험은 1월 30일에 시작합니다.'), '사실이 안 들어갔습니다');
  assert.ok(block.includes('확인하지 못한 내용'), '미확인 항목이 안 들어갔습니다');
  assert.ok(block.includes('본문에 URL 을 직접 적지 마세요'), 'URL 금지 안내가 없습니다');
  assert.equal(buildResearchBlock(null), '', '자료가 없으면 빈 문자열이어야 합니다');
});

// "참고 자료" 라는 말은 표 아래 안내문에도 들어간다.
// 위치를 따질 때는 반드시 소제목 마크업으로 찾아야 엉뚱한 곳을 짚지 않는다.
const h2 = (text) => `<h2 class="wp-block-heading">${text}</h2>`;

test('출처가 있으면 글 끝에 링크 목록이 붙는다', () => {
  const post = buildSamplePost();
  post.sources = sampleSources;
  const content = buildPostContent(post, '', { moreTag: true, sourcesHeading: '참고 자료' });
  assert.ok(content.includes(h2('참고 자료')), '출처 소제목이 없습니다');
  assert.ok(content.includes('href="https://www.q-net.or.kr/notice/1234"'), '링크가 없습니다');
  assert.ok(content.includes('rel="noopener noreferrer"'), 'rel 속성이 없습니다');
  // 출처는 마무리 문단보다 뒤에 와야 읽는 흐름이 끊기지 않는다.
  assert.ok(
    content.indexOf(h2('참고 자료')) > content.indexOf(h2('자주 묻는 질문')),
    '출처가 본문 앞에 있습니다',
  );

  const opens = content.match(/<!-- wp:([a-z-]+)(?: |-->)/g) || [];
  const closes = content.match(/<!-- \/wp:([a-z-]+) -->/g) || [];
  assert.equal(opens.length, closes.length, '출처를 붙이면서 블록 주석 짝이 깨졌습니다');
});

test('출처 제목에 든 HTML 은 이스케이프된다', () => {
  const post = buildSamplePost();
  post.sources = [{ title: '<script>alert(1)</script> 공고', publisher: '', url: 'https://www.q-net.or.kr/x', date: '' }];
  const content = buildPostContent(post, '', {});
  assert.ok(!content.includes('<script>'), '스크립트 태그가 그대로 들어갔습니다');
});

test('출처가 없으면 목록을 붙이지 않는다', () => {
  const content = buildPostContent(buildSamplePost(), '', {});
  assert.ok(!content.includes(h2('참고 자료')), '출처가 없는데 목록이 붙었습니다');
  assert.ok(!content.includes('<a href'), '출처가 없는데 링크가 들어갔습니다');
});

test('마크다운에도 출처 링크가 들어간다', () => {
  const post = buildSamplePost();
  post.sources = sampleSources;
  const markdown = buildMarkdown(post, { sourcesHeading: '참고 자료' });
  assert.ok(markdown.includes('## 참고 자료'), '출처 소제목이 없습니다');
  assert.ok(
    markdown.includes('[국가기술자격 시행계획 공고](https://www.q-net.or.kr/notice/1234)'),
    '마크다운 링크 형식이 아닙니다',
  );
});

test('출처를 붙여도 준수 검사를 통과한다', () => {
  const post = buildSamplePost();
  post.sources = sampleSources;
  const result = checkCompliance(post, settings);
  assert.equal(result.ok, true, `미통과: ${result.issues.map((i) => i.label).join(', ')}`);
});

test('검색을 못 돌린 조사 결과는 미리보기에 경고로 남는다', () => {
  const post = buildSamplePost();
  post.research = { searches: 0, facts: [], sources: [], unverified: ['확인 못 함'], freshness: '' };
  const html = buildPreviewHtml(post, buildPostContent(post, '', {}));
  assert.ok(html.includes('웹 검색이 실제로 실행되지 않았습니다'), '경고가 없습니다');
  assert.ok(html.includes('확인하지 못한 내용'), '미확인 목록이 없습니다');
});

console.log('\n[5] 보조 함수');

test('주제 문자열에서 글의 모양을 알아낸다', () => {
  assert.equal(detectShape('국가기술자격증 TOP 5').shape, 'items');
  assert.equal(detectShape('자격증 7가지 추천').count, 7);
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').shape, 'table');
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').needsChunking, true);
  assert.equal(detectShape('전세 계약 전 확인할 서류').shape, 'general');
});

test('개수를 안 쓴 순위 주제는 목표 개수만큼 크게 뽑는다', () => {
  // 예전에는 항목 5개짜리 글로 잡혀서 "많이 담긴 순위표" 가 안 나왔다.
  const big = detectShape('전국 대학교 순위', 100);
  assert.equal(big.shape, 'table', '큰 표로 안 잡혔습니다');
  assert.equal(big.count, 100);
  assert.equal(big.needsChunking, true);

  assert.equal(detectShape('수도권 대학 서열', 150).count, 150, '설정값을 안 따랐습니다');
  // 주제에 숫자가 있으면 설정값보다 주제의 숫자가 우선이다.
  assert.equal(detectShape('대학 순위 TOP 30', 100).count, 30, '주제의 숫자를 무시했습니다');
  // "추천/비교" 는 항목 몇 개를 깊게 다루는 글이다. 100행 표로 가면 안 된다.
  assert.equal(detectShape('겨울 캠핑 장비 추천', 100).shape, 'items');
  assert.equal(detectShape('겨울 캠핑 장비 추천', 100).count, null);
  // 순위와 무관한 주제는 그대로 정보 정리형.
  assert.equal(detectShape('전세 계약 전 확인할 서류', 100).shape, 'general');
});

console.log('\n[6] 썸네일 배경 그림');

test('썸네일 비율에 가장 가까운 허용 비율을 고른다', () => {
  assert.equal(pickAspectRatio(1200, 630), '16:9');
  assert.equal(pickAspectRatio(1080, 1080), '1:1');
  assert.equal(pickAspectRatio(1080, 1920), '9:16');
  assert.equal(pickAspectRatio(0, 0), '16:9', '잘못된 값에도 기본값이 나와야 합니다');
});

test('그림 프롬프트가 글자를 넣지 말라고 여러 번 못박는다', () => {
  const prompt = buildImagePrompt(
    { scene: 'a safety helmet on a desk', headline: '자격증 정리' },
    'flat',
  );
  assert.ok(prompt.includes('a safety helmet on a desk'), '장면 설명이 안 들어갔습니다');
  for (const ban of ['no text', 'no letters', 'no words', 'no watermark']) {
    assert.ok(prompt.includes(ban), `"${ban}" 금지 문구가 없습니다`);
  }
  // scene 이 비어도 제목으로 프롬프트를 만들 수 있어야 한다.
  assert.ok(buildImagePrompt({ headline: '겨울 캠핑' }, 'flat').includes('no text'));
});

test('배경 그림이 있으면 글자를 얹는 전용 레이아웃으로 간다', () => {
  const spec = {
    headline: '국가기술자격증 TOP 100', subline: '전국을 다 묶었습니다', badge: '자격증',
    emoji: '', accent: '#16324F', width: 1200, height: 630,
  };
  const plain = renderTemplate({ ...spec, style: 'minimal' });
  assert.ok(!plain.includes('<img src='), '배경이 없는데 이미지가 들어갔습니다');

  const withBg = renderTemplate({ ...spec, style: 'minimal', background: 'data:image/png;base64,AAA' });
  assert.ok(withBg.includes('<img src="data:image/png;base64,AAA"'), '배경 그림이 안 들어갔습니다');
  assert.ok(withBg.includes('object-fit:cover'), '배경이 꽉 차게 깔리지 않았습니다');
  // 그림이 밝든 어둡든 흰 글씨가 읽히려면 가림막이 있어야 한다.
  assert.ok(withBg.includes('linear-gradient'), '가림막이 없습니다');
  assert.ok(withBg.includes('국가기술자격증 TOP 100'), '문구가 안 얹혔습니다');
});

test('이미지 생성 모델만 골라낸다', () => {
  const model = (id, methods, description = '') => ({ id, methods, description });
  // Gemini 계열은 generateContent 만 표시돼서 이름으로 봐야 한다.
  assert.equal(looksLikeImageModel(model('gemini-3.1-flash-image', ['generateContent'])), true);
  assert.equal(looksLikeImageModel(model('gemini-3.1-flash-lite-image', ['generateContent'])), true);
  assert.equal(looksLikeImageModel(model('gemini-3-pro-image', ['generateContent'])), true);
  // Imagen 계열은 predict 로 구분된다.
  assert.equal(looksLikeImageModel(model('imagen-4.0-fast-generate-001', ['predict'])), true);
  // 글만 쓰는 모델, 임베딩, 이미지를 "읽는" 모델은 빠져야 한다.
  assert.equal(looksLikeImageModel(model('gemini-3-pro', ['generateContent'])), false);
  assert.equal(looksLikeImageModel(model('text-embedding-004', ['embedContent'])), false);
  assert.equal(looksLikeImageModel(model('gemini-pro-vision', ['generateContent'])), false);
  assert.equal(looksLikeImageModel(model('gemini-2.5-flash-tts', ['generateContent'])), false);
  // 설명에 이미지 생성이라고 적혀 있으면 그것도 본다.
  assert.equal(
    looksLikeImageModel(model('gemini-4-canvas', ['generateContent'], 'Generates images from text')),
    true,
  );
});

const imageModelPool = [
  { id: 'gemini-3-pro-image', methods: ['generateContent'] },
  { id: 'gemini-3.1-flash-image', methods: ['generateContent'] },
  { id: 'gemini-3.1-flash-lite-image', methods: ['generateContent'] },
  { id: 'gemini-3-pro', methods: ['generateContent'] },          // 이미지 모델 아님
  { id: 'text-embedding-004', methods: ['embedContent'] },       // 이미지 모델 아님
];

test('언제나 가장 싼 모델부터 쓴다', () => {
  const ranked = rankImageModels(imageModelPool);
  assert.deepEqual(
    ranked.map((m) => m.id),
    ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image'],
    '싼 순서가 아닙니다',
  );
  assert.equal(ranked[0].tier, 'Flash Lite');
  assert.ok(ranked[0].usd < ranked[2].usd, '가격이 오름차순이 아닙니다');
  // 글자 렌더링 점수는 참고용일 뿐, 순서를 바꾸면 안 된다.
  assert.ok(ranked[0].text < ranked[2].text, '이 표본은 싼 쪽이 글자에 약한 것이 맞습니다');
});

test('글자 확인에 쓸 값싼 모델을 고른다', () => {
  const picked = pickVisionModel([
    { id: 'gemini-3-pro', methods: ['generateContent'] },
    { id: 'gemini-3.1-flash-lite', methods: ['generateContent'] },
    { id: 'gemini-3.1-flash-image', methods: ['generateContent'] },
    { id: 'text-embedding-004', methods: ['embedContent'] },
  ]);
  assert.equal(picked, 'gemini-3.1-flash-lite', '가장 값싼 텍스트 모델이 아닙니다');
  // 이미지 생성 모델은 글자를 읽는 용도로 고르면 안 된다.
  assert.ok(!picked.includes('-image'));
});

test('포스터 프롬프트에 넣을 문구를 한 줄씩 못박는다', () => {
  const prompt = buildPosterPrompt({
    posterLines: ['4년제만 답이 아니다', '취업 최강 전문대'],
    ribbon: 'TOP 50 대공개 (2026 최신)',
    subline: '실무, 자격증, 현장 경험으로 골랐습니다',
    badge: '전문대',
    keywords: ['간호보건', '반도체', '항공'],
    scene: 'a bright technical college workshop',
  }, 'bold');

  for (const line of ['4년제만 답이 아니다', '취업 최강 전문대', 'TOP 50 대공개 (2026 최신)', '전문대', '간호보건']) {
    assert.ok(prompt.includes(line), `"${line}" 이 프롬프트에 없습니다`);
  }
  assert.ok(prompt.includes('a bright technical college workshop'), '장면 설명이 없습니다');
  // 한글이 깨지지 않게 하는 지시가 들어 있어야 한다.
  assert.ok(/every Korean character must be rendered perfectly/i.test(prompt), '한글 정확도 지시가 없습니다');
  assert.ok(/Do NOT add any other text/i.test(prompt), '다른 글자 금지 지시가 없습니다');
  // 배경 전용 프롬프트와 달리 여기서는 글자를 넣어야 한다.
  assert.ok(!/^no text/m.test(prompt), '포스터인데 글자 금지가 들어갔습니다');
});

test('posterLines 가 없으면 headline 으로 대신한다', () => {
  const prompt = buildPosterPrompt({ headline: '겨울 캠핑 장비 정리' }, 'clean');
  assert.ok(prompt.includes('겨울 캠핑 장비 정리'), '제목이 안 들어갔습니다');
});

test('문구에 든 따옴표와 줄바꿈이 프롬프트를 깨뜨리지 않는다', () => {
  const prompt = buildPosterPrompt({ posterLines: ['이건 "인용" 이다\n두 줄'] }, 'bold');
  assert.ok(!prompt.includes('\n'), '줄바꿈이 그대로 들어갔습니다');
  assert.ok(prompt.includes('이건 인용 이다 두 줄'), '따옴표 정리가 안 됐습니다');
});

test('가격표에 없는 새 모델도 등급 이름으로 짐작한다', () => {
  // 구글이 새 모델을 내놔도 프로그램이 멈추면 안 된다.
  const lite = priceOf('gemini-9-flash-lite-image');
  const pro = priceOf('gemini-9-pro-image');
  assert.ok(lite.usd < pro.usd, 'lite 가 pro 보다 비싸게 잡혔습니다');

  const unknown = priceOf('gemini-9-mystery-image');
  assert.equal(unknown.known, false);
  // 모르는 모델은 비싼 쪽으로 본다. 아는 모델을 우선 쓰게 하기 위해서다.
  assert.ok(unknown.usd > priceOf('gemini-3.1-flash-image').usd, '모르는 모델이 먼저 골라집니다');
});

test('값이 같으면 가격을 아는 모델을 먼저 쓴다', () => {
  const ranked = rankImageModels([
    { id: 'gemini-9-fast-image', methods: ['generateContent'] },   // 추정 $0.03
    { id: 'imagen-4.0-fast-generate-001', methods: ['predict'] },  // 확실 $0.02
  ]);
  assert.equal(ranked[0].id, 'imagen-4.0-fast-generate-001');
  assert.equal(ranked[0].knownPrice, true);
});

test('API 키는 대시보드로 내려보내지 않는다', () => {
  const saved = saveSettings({ image: { apiKey: 'AIzaSECRETKEY' } });
  assert.equal(saved.image.apiKey, 'AIzaSECRETKEY', '설정에는 저장되어야 합니다');
  const shown = publicSettings();
  assert.equal(shown.image.apiKey, '', 'API 키가 화면으로 새어나갔습니다');
  assert.equal(shown.image.apiKeySet, true, '키가 있다는 표시가 없습니다');
  // 화면의 마스킹 값이 되돌아와도 진짜 키를 덮어쓰면 안 된다.
  saveSettings({ image: { apiKey: '●●●●●●' } });
  assert.equal(getSettings().image.apiKey, 'AIzaSECRETKEY', '마스킹 값이 키를 덮어썼습니다');
  saveSettings({ image: { apiKey: '' } });
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
