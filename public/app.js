const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  pending: '대기',
  researching: '자료 조사 중',
  writing: '글 작성 중',
  checking: '준수 보정 중',
  thumbnail: '썸네일 생성',
  posting: '워드프레스 저장 중',
  done: '완료',
  failed: '실패',
  skipped: '건너뜀',
};

const CUSTOM_MODEL = '__custom__';

let state = {
  settings: null, site: null, jobs: [], runner: null,
  models: [], examples: [], rules: [], categories: [],
};

/* ---------- 공통 ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, message: '응답을 읽지 못했습니다.' }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `요청 실패 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function shortModel(id) {
  if (!id) return '-';
  const known = (state.models || []).find((model) => model.id === id);
  if (known) return known.label.split(' — ')[0];
  return id.replace(/^claude-/, '');
}

/* ---------- 렌더 ---------- */

function renderPills(health) {
  if (health) {
    const claude = $('pill-claude');
    const browser = $('pill-browser');
    claude.textContent = health.claude.ok ? `AI 준비됨 · ${health.claude.version.split(' ')[0]}` : 'claude CLI 없음';
    claude.className = `pill ${health.claude.ok ? 'ok' : 'bad'}`;
    browser.textContent = health.browser.ok ? '썸네일 준비됨' : '썸네일 렌더러 실패';
    browser.className = `pill ${health.browser.ok ? 'ok' : 'bad'}`;
  }
  renderSite();
  renderModelPill();
}

function renderModelPill() {
  const pill = $('pill-model');
  const id = state.settings?.claude?.model || '';
  pill.textContent = `모델: ${id ? shortModel(id) : '기본값'}`;
  pill.className = `pill ${id ? 'ok' : ''}`.trim();
}

function renderSite() {
  const pill = $('pill-site');
  const site = state.site || {};

  if (site.connected && site.canPublish) {
    pill.textContent = `연결됨 · ${site.siteName || site.site || ''}`;
    pill.className = 'pill ok';
  } else if (site.connected) {
    pill.textContent = '권한 부족';
    pill.className = 'pill warn';
  } else {
    pill.textContent = '워드프레스 연결 필요';
    pill.className = 'pill bad';
  }

  const detail = $('site-detail');
  if (site.connected) {
    const who = [site.userName, site.roles?.join(', ')].filter(Boolean).join(' · ');
    detail.textContent = `${who}${site.checkedAt ? ` · 마지막 확인 ${new Date(site.checkedAt).toLocaleString('ko-KR')}` : ''}`;
  } else {
    detail.textContent = site.message || '응용 프로그램 비밀번호는 이 컴퓨터에만 저장됩니다.';
  }

  $('pass-state').textContent = state.settings?.site?.appPasswordSet
    ? '저장된 비밀번호가 있습니다. 바꿀 때만 새로 입력하세요.'
    : '아직 저장된 비밀번호가 없습니다.';

  renderCategories();
}

function renderCategories() {
  const select = $('category-select');
  const current = String(state.settings?.site?.categoryId || 0);
  const options = ['<option value="0">— 워드프레스 기본 카테고리 —</option>'];
  for (const category of state.categories || []) {
    options.push(
      `<option value="${category.id}">${escapeHtml(category.name)} (${category.count})</option>`,
    );
  }
  select.innerHTML = options.join('');
  select.value = (state.categories || []).some((c) => String(c.id) === current) ? current : '0';
}

function renderRules() {
  $('rule-list').innerHTML = (state.rules || [])
    .map((rule) => `<li><span class="rule-dot"></span>${escapeHtml(rule.label)}</li>`)
    .join('');
}

function renderModels() {
  const select = $('s-model');
  const current = state.settings?.claude?.model || '';
  const known = (state.models || []).some((model) => model.id === current);

  select.innerHTML = (state.models || [])
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`)
    .join('') + `<option value="${CUSTOM_MODEL}">직접 입력…</option>`;

  if (current && !known) {
    select.value = CUSTOM_MODEL;
    $('s-model-custom').value = current;
    $('model-custom-wrap').classList.remove('hidden');
  } else {
    select.value = current;
    $('model-custom-wrap').classList.add('hidden');
  }
  updateModelNote();
}

function updateModelNote() {
  const select = $('s-model');
  const model = (state.models || []).find((item) => item.id === select.value);
  $('model-note').textContent = select.value === CUSTOM_MODEL
    ? 'claude CLI 가 아는 모델 이름을 그대로 적으세요.'
    : (model?.note || '');
}

function renderExamples() {
  const list = state.examples || [];
  $('example-count').textContent = `${list.length}개${list.length ? ` (켜짐 ${list.filter((e) => e.enabled).length}개)` : ''}`;
  $('example-list').innerHTML = list.length
    ? list.map((entry) => `
        <li class="${entry.enabled ? '' : 'off'}">
          <label class="ex-toggle">
            <input type="checkbox" data-toggle="${entry.id}" ${entry.enabled ? 'checked' : ''}>
            <span class="ex-name">${escapeHtml(entry.name)}</span>
          </label>
          <span class="ex-meta">${entry.chars.toLocaleString()}자${entry.truncated ? ' · 일부만 저장됨' : ''}</span>
          <button class="btn ghost small danger" data-ex-remove="${entry.id}">삭제</button>
        </li>`).join('')
    : '<li class="empty-row">아직 올린 예시가 없습니다.</li>';
}

/** 준수 점검 결과를 한 칸짜리 배지로. 마우스를 올리면 항목별 내용이 보인다. */
function complianceCell(job) {
  const compliance = job.compliance;
  if (!compliance) return '<span class="hint">-</span>';
  const tooltip = compliance.results
    .map((result) => `${result.ok ? '[통과]' : '[미통과]'} ${result.label} — ${result.detail}`)
    .join('\n');
  const cls = compliance.ok ? 'pass' : 'fail';
  return `<span class="check-badge ${cls}" title="${escapeHtml(tooltip)}">`
    + `${compliance.passed}/${compliance.total}</span>`;
}

/**
 * 검색 횟수와 출처 개수.
 * 검색이 0회면 "검색했다고 말만 한" 결과라 경고로 표시한다.
 */
function sourceCell(job) {
  if (!job.sourceCount && !job.searches) return '<span class="hint">-</span>';
  const cls = job.searches ? 'pass' : 'fail';
  const tip = job.searches
    ? `웹 검색 ${job.searches}회로 모은 출처 ${job.sourceCount}건을 글 끝에 붙였습니다.`
    : '웹 검색이 실제로 실행되지 않았습니다. 내용을 직접 확인하세요.';
  return `<span class="check-badge ${cls}" title="${escapeHtml(tip)}">`
    + `${job.searches}회 / ${job.sourceCount}건</span>`;
}

function renderJobs() {
  const body = $('job-body');
  const jobs = state.jobs || [];
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">아직 추가된 주제가 없습니다.</td></tr>';
    return;
  }
  const current = state.runner?.currentJobId;
  body.innerHTML = jobs
    .map((job, index) => {
      const label = STATUS_LABEL[job.status] || job.status;
      const thumb = job.thumbnailPath
        ? `<a href="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" target="_blank" rel="noopener">
             <img src="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" alt="썸네일"></a>`
        : '<span class="hint">-</span>';
      const note = job.guidelineCheck
        ? `<span class="check-note" title="${escapeHtml(job.guidelineCheck)}">지침 확인</span>`
        : '';
      const links = [];
      if (job.editUrl) {
        links.push(`<a class="post-link" href="${escapeHtml(job.editUrl)}" target="_blank" rel="noopener">초안 열기</a>`);
      }
      if (job.archiveDir) {
        const dir = encodeURIComponent(job.archiveDir);
        links.push(`<a class="post-link" href="/posts/${dir}/post.md" target="_blank" rel="noopener">마크다운</a>`);
        links.push(`<a class="post-link" href="/posts/${dir}/preview.html" target="_blank" rel="noopener">미리보기</a>`);
        if (job.sourceCount || job.searches) {
          links.push(`<a class="post-link" href="/posts/${dir}/research.json" target="_blank" rel="noopener">조사 자료</a>`);
        }
      }
      const warn = job.unverified
        ? `<span class="check-badge fail" title="조사에서 확인하지 못한 내용이 ${job.unverified}건 있습니다. 발행 전에 확인하세요.">미확인 ${job.unverified}</span>`
        : '';
      return `<tr class="${job.id === current ? 'active' : ''}">
        <td>${index + 1}</td>
        <td class="topic">${escapeHtml(job.topic)}</td>
        <td><span class="badge ${job.status}">${label}</span></td>
        <td class="msg">${job.title ? `<b>${escapeHtml(job.title)}</b>` : ''}${escapeHtml(job.message || '')}
          <div class="msg-links">${note} ${warn} ${links.join(' ')}</div></td>
        <td>${job.charCount ? job.charCount.toLocaleString() : '-'}</td>
        <td>${complianceCell(job)}</td>
        <td class="src-cell">${sourceCell(job)}</td>
        <td>${job.tableRows ? `${job.tableRows}행` : '-'}</td>
        <td class="model-cell">${escapeHtml(shortModel(job.model))}</td>
        <td class="thumb-cell">${thumb}</td>
        <td>
          <button class="btn ghost small" data-retry="${job.id}">재시도</button>
          <button class="btn ghost small danger" data-remove="${job.id}">삭제</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderRunner() {
  const runner = state.runner;
  if (!runner) return;
  const { total, done, failed, pending } = runner.stats;
  const finished = done + failed;
  $('progress-bar').style.width = total ? `${Math.round((finished / total) * 100)}%` : '0%';

  let text = `전체 ${total} · 완료 ${done} · 실패 ${failed} · 대기 ${pending}`;
  if (runner.running) text += runner.paused ? ' · 일시정지' : ' · 실행 중';
  if (runner.waitUntil) {
    const left = Math.max(0, Math.round((runner.waitUntil - Date.now()) / 1000));
    text += ` · 다음 글까지 ${left}초`;
  }
  $('run-stats').textContent = text;

  $('btn-start').disabled = runner.running || pending === 0;
  $('btn-pause').disabled = !runner.running;
  $('btn-pause').textContent = runner.paused ? '이어서 실행' : '일시정지';
  $('btn-stop').disabled = !runner.running;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('s-site-url').value = s.site.url || '';
  $('s-site-user').value = s.site.username || '';

  $('s-research').checked = Boolean(s.research.enabled);
  $('s-searches').value = s.research.maxSearches;
  $('s-show-sources').checked = Boolean(s.research.showSources);
  $('s-require-sources').checked = Boolean(s.research.requireSources);
  $('s-sources-heading').value = s.research.sourcesHeading || '';

  $('s-min-chars').value = s.post.minChars;
  $('s-sections').value = s.post.sectionCount;
  $('s-rank-count').value = s.post.rankTargetCount;
  $('s-repairs').value = s.adsense.maxRepairs;
  $('s-enforce').checked = Boolean(s.adsense.enforce);
  $('s-block').checked = Boolean(s.adsense.blockOnFail);
  $('s-criteria').checked = Boolean(s.post.addCriteria);
  $('s-faq').checked = Boolean(s.post.addFaq);

  $('s-tone').value = s.post.tone;
  $('s-audience').value = s.post.audience;
  $('s-more').checked = Boolean(s.post.moreTag);
  $('s-tags').checked = Boolean(s.post.applyTags);
  $('s-slug').checked = Boolean(s.post.useAiSlug);
  if (document.activeElement !== $('s-guideline')) {
    $('s-guideline').value = s.post.extraGuideline || '';
  }

  $('s-thumb-style').value = s.thumbnail.style;
  $('s-thumb-w').value = s.thumbnail.width;
  $('s-thumb-h').value = s.thumbnail.height;
  $('s-thumb-insert').checked = Boolean(s.thumbnail.insert);
  $('s-thumb-featured').checked = Boolean(s.thumbnail.featured);
  $('s-thumb-emoji').checked = Boolean(s.thumbnail.emoji);

  $('s-image').checked = Boolean(s.image.enabled);
  $('s-image-mode').value = s.image.mode || 'full';
  $('s-image-poster').value = s.image.poster || 'bold';
  $('s-verify-text').checked = Boolean(s.image.verifyText);
  // 비어 있으면 자동. placeholder 가 그렇게 안내한다.
  $('s-image-model').value = s.image.model || '';
  $('s-image-style').value = s.image.style || 'flat';
  $('image-key-state').textContent = s.image.apiKeySet
    ? '저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.'
    : 'aistudio.google.com 에서 무료로 발급됩니다';

  $('s-delay-min').value = s.run.delayMinSec;
  $('s-delay-max').value = s.run.delayMaxSec;
  $('s-retries').value = s.run.maxRetries;

  renderModels();
  renderModelPill();
  renderCategories();
}

function appendLog(entry) {
  const box = $('console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'line';
  const time = new Date(entry.ts).toLocaleTimeString('ko-KR', { hour12: false });
  line.innerHTML = `<span class="ts">${time}</span><span class="${entry.level}">${escapeHtml(entry.message)}</span>`;
  box.appendChild(line);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- 이벤트 스트림 ---------- */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'log') appendLog(payload);
    else if (type === 'jobs') { state.jobs = payload; renderJobs(); }
    else if (type === 'job') {
      const index = state.jobs.findIndex((job) => job.id === payload.id);
      if (index >= 0) state.jobs[index] = payload; else state.jobs.push(payload);
      renderJobs();
    } else if (type === 'runner') { state.runner = payload; renderRunner(); renderJobs(); }
    else if (type === 'examples') { state.examples = payload; renderExamples(); }
    else if (type === 'site') { state.site = payload; renderSite(); }
  };
  source.onerror = () => { /* EventSource 가 알아서 재접속한다. */ };
}

/* ---------- 초기화 ---------- */

async function refreshState() {
  const data = await api('/api/state');
  state = {
    ...state,
    settings: data.settings,
    site: data.site,
    jobs: data.jobs,
    runner: data.runner,
    models: data.models || state.models,
    rules: data.rules || state.rules,
    examples: data.examples || [],
  };
  renderRules();
  renderSettings();
  renderSite();
  renderExamples();
  renderJobs();
  renderRunner();
  return data;
}

async function loadCategories(quiet = true) {
  try {
    const data = await api('/api/site/categories');
    state.categories = data.categories || [];
    renderCategories();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

async function boot() {
  const data = await refreshState();
  $('console').innerHTML = '';
  (data.logs || []).forEach(appendLog);
  connectStream();
  api('/api/health').then(renderPills).catch(() => {});
  if (data.site?.connected) loadCategories();
  setInterval(renderRunner, 1000);
}

/* ---------- 설정 저장 ---------- */

function collectSettings() {
  const select = $('s-model');
  const model = select.value === CUSTOM_MODEL ? $('s-model-custom').value.trim() : select.value;
  return {
    claude: { model },
    post: {
      tone: $('s-tone').value,
      minChars: Number($('s-min-chars').value),
      sectionCount: Number($('s-sections').value),
      audience: $('s-audience').value,
      extraGuideline: $('s-guideline').value,
      addCriteria: $('s-criteria').checked,
      addFaq: $('s-faq').checked,
      moreTag: $('s-more').checked,
      applyTags: $('s-tags').checked,
      useAiSlug: $('s-slug').checked,
    },
    adsense: {
      enforce: $('s-enforce').checked,
      maxRepairs: Number($('s-repairs').value),
      blockOnFail: $('s-block').checked,
    },
    thumbnail: {
      style: $('s-thumb-style').value,
      width: Number($('s-thumb-w').value),
      height: Number($('s-thumb-h').value),
      insert: $('s-thumb-insert').checked,
      featured: $('s-thumb-featured').checked,
      emoji: $('s-thumb-emoji').checked,
    },
    image: {
      enabled: $('s-image').checked,
      mode: $('s-image-mode').value,
      poster: $('s-image-poster').value,
      verifyText: $('s-verify-text').checked,
      model: $('s-image-model').value.trim(),
      style: $('s-image-style').value,
    },
    run: {
      delayMinSec: Number($('s-delay-min').value),
      delayMaxSec: Number($('s-delay-max').value),
      maxRetries: Number($('s-retries').value),
    },
  };
}

async function patchSettings(patch) {
  const data = await api('/api/settings', { method: 'POST', body: patch });
  state.settings = data.settings;
  renderModelPill();
  return data.settings;
}

/* ---------- 워드프레스 연결 ---------- */

$('btn-connect').onclick = async () => {
  const button = $('btn-connect');
  button.disabled = true;
  toast('워드프레스에 연결하는 중...');
  try {
    const data = await api('/api/site/connect', {
      method: 'POST',
      body: {
        url: $('s-site-url').value,
        username: $('s-site-user').value,
        appPassword: $('s-site-pass').value,
      },
    });
    state.site = data.site;
    state.settings = data.settings;
    state.categories = data.categories || [];
    $('s-site-pass').value = '';
    renderSite();
    renderSettings();
    toast(data.site.connected
      ? `연결되었습니다: ${data.site.siteName || data.site.site}`
      : `연결 실패: ${data.site.message}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};

$('btn-categories').onclick = async () => {
  await loadCategories(false);
  toast(`카테고리 ${state.categories.length}개를 찾았습니다.`);
};

$('btn-disconnect').onclick = async () => {
  if (!confirm('저장된 응용 프로그램 비밀번호와 연결 정보를 지울까요?')) return;
  const data = await api('/api/site/disconnect', { method: 'POST' });
  state.site = data.site;
  state.settings = data.settings;
  state.categories = [];
  renderSite();
  toast('연결 정보를 지웠습니다.');
};

$('category-select').addEventListener('change', async () => {
  const id = Number($('category-select').value) || 0;
  const name = (state.categories || []).find((c) => c.id === id)?.name || '';
  await patchSettings({ site: { categoryId: id, categoryName: name } });
  toast(id ? `카테고리를 "${name}" 로 정했습니다.` : '워드프레스 기본 카테고리를 씁니다.');
});

/* ---------- 주제 ---------- */

let previewTimer = null;
$('topics').addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const data = await api('/api/topics/preview', { method: 'POST', body: { raw: $('topics').value } });
    $('paste-count').textContent = `${data.count}개 인식`;
  }, 250);
});

$('btn-add').onclick = async () => {
  const raw = $('topics').value;
  if (!raw.trim()) return toast('먼저 주제를 붙여넣어 주세요.');
  const data = await api('/api/topics', { method: 'POST', body: { raw } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
  toast(`${data.added}건 추가${data.skipped ? ` (중복 ${data.skipped}건 제외)` : ''}`);
};

$('btn-clear-text').onclick = () => {
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
};

/* 추가 지침 — 저장 버튼을 누르지 않아도 자동으로 저장한다. */
let guidelineTimer = null;
function saveGuideline(immediate = false) {
  clearTimeout(guidelineTimer);
  const run = async () => {
    $('guideline-state').textContent = '저장 중...';
    try {
      await patchSettings({ post: { extraGuideline: $('s-guideline').value } });
      const length = $('s-guideline').value.trim().length;
      $('guideline-state').textContent = length
        ? `저장됨 · ${length}자 (다음 글부터 적용)`
        : '애드센스 필수 규칙은 자동으로 들어갑니다';
    } catch (error) {
      $('guideline-state').textContent = `저장 실패: ${error.message}`;
    }
  };
  if (immediate) run();
  else guidelineTimer = setTimeout(run, 700);
}
$('s-guideline').addEventListener('input', () => saveGuideline());
$('s-guideline').addEventListener('blur', () => saveGuideline(true));

/* 준수 규칙 칸의 입력은 바로 저장한다. */
for (const id of ['s-min-chars', 's-sections', 's-rank-count', 's-repairs', 's-enforce', 's-block', 's-criteria', 's-faq']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      post: {
        minChars: Number($('s-min-chars').value),
        sectionCount: Number($('s-sections').value),
        rankTargetCount: Number($('s-rank-count').value),
        addCriteria: $('s-criteria').checked,
        addFaq: $('s-faq').checked,
      },
      adsense: {
        enforce: $('s-enforce').checked,
        maxRepairs: Number($('s-repairs').value),
        blockOnFail: $('s-block').checked,
      },
    });
    toast('준수 규칙 설정을 저장했습니다.');
  });
}

/* ---------- 자료 조사 ---------- */

for (const id of ['s-research', 's-searches', 's-show-sources', 's-require-sources', 's-sources-heading']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      research: {
        enabled: $('s-research').checked,
        maxSearches: Number($('s-searches').value),
        showSources: $('s-show-sources').checked,
        requireSources: $('s-require-sources').checked,
        sourcesHeading: $('s-sources-heading').value.trim() || '참고 자료',
      },
    });
    toast($('s-research').checked
      ? '자료 조사 설정을 저장했습니다.'
      : '자료 조사를 껐습니다. 앞으로는 검색 없이 글을 씁니다.');
  });
}

$('btn-test-research').onclick = async () => {
  const box = $('research-test-result');
  const button = $('btn-test-research');
  const topic = (state.jobs || [])[0]?.topic || '';
  button.disabled = true;
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = '검색하는 중... (최대 7분)';
  try {
    const data = await api('/api/research/test', { method: 'POST', body: { topic } });
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}`;
    } else if (!data.searches) {
      // 검색을 한 번도 안 돌린 채로 답이 온 경우. 그대로 믿으면 안 된다.
      box.classList.add('bad');
      box.textContent =
        '웹 검색이 실제로 실행되지 않았습니다 (검색 0회).\n'
        + '모아온 내용이 검색 결과가 아니라 모델이 아는 내용일 수 있습니다.\n'
        + 'claude CLI 를 최신 버전으로 올리고 구독 플랜에서 웹 검색을 쓸 수 있는지 확인해 보세요.';
    } else {
      box.classList.add('good');
      box.textContent =
        `성공 — 검색 ${data.searches}회, 사실 ${data.facts}건, 출처 ${data.sources.length}건`
        + `${data.unverified ? `, 미확인 ${data.unverified}건` : ''}\n`
        + (data.freshness ? `최신성: ${data.freshness}\n` : '')
        + '\n찾아온 출처:\n'
        + data.sources.map((s) => `- ${s.title}\n  ${s.url}`).join('\n');
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

/* ---------- 설정 ---------- */

$('btn-toggle-settings').onclick = () => {
  const panel = $('settings');
  panel.classList.toggle('hidden');
  $('btn-toggle-settings').textContent = panel.classList.contains('hidden') ? '펼치기' : '접기';
};

$('s-model').addEventListener('change', async () => {
  const custom = $('s-model').value === CUSTOM_MODEL;
  $('model-custom-wrap').classList.toggle('hidden', !custom);
  updateModelNote();
  if (custom) {
    $('s-model-custom').focus();
    return;
  }
  await patchSettings({ claude: { model: $('s-model').value } });
  toast(`모델을 ${shortModel($('s-model').value) || '기본값'}(으)로 바꿨습니다.`);
});

$('s-model-custom').addEventListener('change', async () => {
  await patchSettings({ claude: { model: $('s-model-custom').value.trim() } });
  toast('모델을 저장했습니다.');
});

$('btn-save-settings').onclick = async () => {
  await patchSettings(collectSettings());
  toast('설정을 저장했습니다.');
};

$('btn-test-ai').onclick = async () => {
  const box = $('ai-test-result');
  const button = $('btn-test-ai');
  button.disabled = true;
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = '테스트 중... (최대 2분)';
  try {
    const data = await api('/api/ai/test', { method: 'POST' });
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}` + (data.dumpFile ? `\n원문: ${data.dumpFile}` : '');
    } else {
      box.classList.add('good');
      box.textContent =
        `성공 — 모델 ${shortModel(data.model)} (${data.model})\n` +
        `응답: ${data.answer} · ${Math.round((data.durationMs || 0) / 100) / 10}초`;
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

/* ---------- 썸네일 배경 그림 ---------- */

for (const id of ['s-image', 's-image-mode', 's-image-poster', 's-verify-text', 's-image-model', 's-image-style']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      image: {
        enabled: $('s-image').checked,
        mode: $('s-image-mode').value,
        poster: $('s-image-poster').value,
        verifyText: $('s-verify-text').checked,
        model: $('s-image-model').value.trim(),
        style: $('s-image-style').value,
      },
    });
    toast($('s-image').checked
      ? '이미지 생성을 켰습니다. 키가 없으면 HTML 썸네일로 만듭니다.'
      : '이미지 생성을 껐습니다.');
  });
}

// 키는 입력하는 즉시 저장하지 않는다. 테스트 버튼으로 확인하면서 같이 저장한다.
$('s-image-key').addEventListener('change', async () => {
  const apiKey = $('s-image-key').value.trim();
  if (!apiKey) return;
  await patchSettings({ image: { apiKey } });
  $('s-image-key').value = '';
  $('image-key-state').textContent = '저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.';
  toast('이미지 API 키를 저장했습니다.');
});

/** 자동으로 고른 후보 목록을 보기 좋게. 고른 것에 화살표를 붙인다. */
function candidateLines(candidates, picked) {
  if (!candidates?.length) return '';
  const lines = candidates.map((model) => {
    const mark = model.id === picked ? '→ ' : '   ';
    const price = model.knownPrice ? `$${model.usd}` : `$${model.usd} (추정)`;
    return `${mark}${model.id}  ${price}  ${model.tier}`;
  });
  return `\n\n쓸 수 있는 모델 (싼 순서):\n${lines.join('\n')}`;
}

async function runImageTest({ refresh = false } = {}) {
  const box = $('image-test-result');
  const preview = $('image-test-preview');
  const button = $('btn-test-image');
  const refreshButton = $('btn-refresh-models');
  button.disabled = true;
  refreshButton.disabled = true;
  preview.classList.add('hidden');
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = refresh
    ? '모델 목록을 다시 받고 그림 한 장을 뽑는 중... (최대 2분)'
    : '그림 한 장을 뽑는 중... (최대 2분)';
  try {
    const data = await api('/api/image/test', {
      method: 'POST',
      body: {
        apiKey: $('s-image-key').value.trim(),
        model: $('s-image-model').value.trim(),
        style: $('s-image-style').value,
        mode: $('s-image-mode').value,
        poster: $('s-image-poster').value,
        refresh,
      },
    });
    state.settings = data.settings || state.settings;
    $('s-image-key').value = '';
    renderSettings();
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}${candidateLines(data.candidates, '')}`;
    } else {
      box.classList.add('good');
      const price = data.usd ? ` · 장당 약 $${data.usd}` : '';
      const full = data.mode === 'full';
      const how = full
        ? (data.auto ? '자동으로 한글을 잘 그리는 모델을 골랐습니다.' : '설정에 적은 모델을 썼습니다.')
        : (data.auto ? '자동으로 가장 싼 모델을 골랐습니다.' : '설정에 적은 모델을 썼습니다.');
      const textNote = data.textOk === false
        ? `\n글자 확인: 깨짐 — ${data.textReason}\n(실제 실행에서는 한 번 더 그려보고, 그래도 깨지면 HTML 썸네일로 물러섭니다)`
        : (data.textOk === true ? '\n글자 확인: 통과' : '');
      box.textContent =
        `성공 — ${data.model}${data.tier ? ` (${data.tier})` : ''}${price} · ${data.kb}KB\n`
        + `${how}\n`
        + (full
          ? '아래 그림에 한글이 제대로 박혔는지 직접 확인해 주세요.'
          : '이 그림 위에 한글 문구가 얹힙니다. 그림 자체에는 글자가 없어야 정상입니다.')
        + textNote
        + candidateLines(data.candidates, data.model);
      preview.src = data.dataUri;
      preview.classList.remove('hidden');
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
    refreshButton.disabled = false;
  }
}

$('btn-test-image').onclick = () => runImageTest();
$('btn-refresh-models').onclick = () => runImageTest({ refresh: true });

$('btn-preview-thumb').onclick = () => {
  const params = new URLSearchParams({
    headline: '국가기술자격증 TOP 5',
    subline: '취업률과 활용성을 기준으로 정리했습니다',
    badge: '자격증',
    accent: '#16324F',
    style: $('s-thumb-style').value,
  });
  const frame = $('thumb-preview');
  frame.src = `/api/thumbnail/preview?${params}`;
  frame.classList.remove('hidden');
};

/* ---------- 참고 예시 ---------- */

$('example-file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  for (const file of files) {
    try {
      const content = await file.text();
      await api('/api/examples', { method: 'POST', body: { name: file.name, content } });
    } catch (error) {
      toast(`${file.name}: ${error.message}`);
    }
  }
  await refreshState();
  toast(`예시 ${files.length}개를 올렸습니다.`);
});

$('btn-example-paste').onclick = () => {
  $('example-paste-box').classList.toggle('hidden');
  if (!$('example-paste-box').classList.contains('hidden')) $('example-text').focus();
};

$('btn-example-cancel').onclick = () => {
  $('example-paste-box').classList.add('hidden');
  $('example-text').value = '';
  $('example-name').value = '';
};

$('btn-example-save').onclick = async () => {
  const content = $('example-text').value;
  if (!content.trim()) return toast('예시 내용을 붙여넣어 주세요.');
  await api('/api/examples', {
    method: 'POST',
    body: { name: $('example-name').value || '붙여넣은 예시', content },
  });
  $('example-text').value = '';
  $('example-name').value = '';
  $('example-paste-box').classList.add('hidden');
  await refreshState();
  toast('예시를 저장했습니다.');
};

$('example-list').addEventListener('click', async (event) => {
  const removeId = event.target.dataset.exRemove;
  if (!removeId) return;
  await api(`/api/examples/${removeId}`, { method: 'DELETE' });
  await refreshState();
});

$('example-list').addEventListener('change', async (event) => {
  const toggleId = event.target.dataset.toggle;
  if (!toggleId) return;
  await api(`/api/examples/${toggleId}/toggle`, {
    method: 'POST',
    body: { enabled: event.target.checked },
  });
  await refreshState();
});

/* ---------- 실행 ---------- */

$('btn-start').onclick = async () => {
  try {
    await api('/api/run/start', { method: 'POST' });
    toast('실행을 시작했습니다.');
  } catch (error) { toast(error.message); }
};
$('btn-pause').onclick = () => api('/api/run/pause', { method: 'POST' }).catch((e) => toast(e.message));
$('btn-stop').onclick = () => api('/api/run/stop', { method: 'POST' }).catch((e) => toast(e.message));

$('btn-clear-done').onclick = async () => {
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: true } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-all').onclick = async () => {
  if (!confirm('작업 목록을 모두 비울까요?')) return;
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: false } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-log').onclick = () => { $('console').innerHTML = ''; };

$('job-body').addEventListener('click', async (event) => {
  const retry = event.target.dataset.retry;
  const remove = event.target.dataset.remove;
  if (retry) { await api(`/api/jobs/${retry}/retry`, { method: 'POST' }); await refreshState(); }
  if (remove) { await api(`/api/jobs/${remove}`, { method: 'DELETE' }); await refreshState(); }
});

boot().catch((error) => toast(error.message));
