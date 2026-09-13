import fs from 'node:fs';
import path from 'node:path';
import { STATUS, updateJob, nextPending, stats } from '../lib/store.js';
import { getSettings } from '../lib/settings.js';
import { generatePost, countChars } from '../content/generator.js';
import { summarize } from '../content/adsense.js';
import { renderThumbnail } from '../content/thumbnail.js';
import { buildPostContent, buildPreviewHtml } from '../content/gutenberg.js';
import { buildMarkdown } from '../content/markdown.js';
import { saveDraft } from '../wordpress/publisher.js';
import { readSiteInfo } from '../wordpress/client.js';
import { OUTPUT_DIR, ensureDirs } from '../lib/paths.js';
import { logger, push } from '../lib/events.js';
import { sleep, randomBetween, slugify } from '../lib/util.js';

const state = {
  running: false,
  paused: false,
  currentJobId: null,
  abort: null,
  waitUntil: null,
};

export function getRunnerState() {
  return {
    running: state.running,
    paused: state.paused,
    currentJobId: state.currentJobId,
    waitUntil: state.waitUntil,
    stats: stats(),
  };
}

function broadcast() {
  push('runner', getRunnerState());
}

/**
 * 결과물을 파일로도 남겨둔다. 워드프레스 저장이 실패해도 글은 살아 있게.
 * post.md 는 구텐베르크 편집기에 그대로 붙여넣을 수 있는 마크다운이다.
 */
function archivePost(job, post, thumbnailPath) {
  ensureDirs();
  const base = `${slugify(job.topic, 30)}-${job.id}`;
  const dir = path.join(OUTPUT_DIR, base);
  fs.mkdirSync(dir, { recursive: true });

  const thumbName = thumbnailPath ? path.basename(thumbnailPath) : '';
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    fs.copyFileSync(thumbnailPath, path.join(dir, thumbName));
  }

  const settings = getSettings();
  const sourcesHeading = settings.research.sourcesHeading;
  const content = buildPostContent(post, '', { moreTag: settings.post.moreTag, sourcesHeading });

  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(post, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'post.md'),
    buildMarkdown(post, { thumbnailFile: thumbName, sourcesHeading }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'content.html'), content, 'utf8');
  fs.writeFileSync(path.join(dir, 'preview.html'), buildPreviewHtml(post, content), 'utf8');

  // 조사 원자료를 따로 남긴다. 발행 전에 "무엇을 근거로 썼는지" 확인하는 용도다.
  if (post.research) {
    fs.writeFileSync(path.join(dir, 'research.json'), JSON.stringify(post.research, null, 2), 'utf8');
  }
  return dir;
}

async function processJob(job) {
  state.currentJobId = job.id;
  broadcast();

  const settings = getSettings();

  updateJob(job.id, {
    status: settings.research.enabled ? STATUS.RESEARCHING : STATUS.WRITING,
    message: settings.research.enabled
      ? '웹에서 최신 자료를 찾는 중...'
      : 'AI가 애드센스 승인 기준에 맞춰 글을 쓰는 중...',
    attempts: job.attempts + 1,
  });
  logger.step(`[${job.topic}] 글 생성 시작`, { jobId: job.id });

  const post = await generatePost(job.topic, {
    signal: state.abort?.signal,
    onResearch: () => {
      if (!settings.research.enabled) return;
      updateJob(job.id, { status: STATUS.RESEARCHING, message: '웹에서 최신 자료를 찾는 중...' });
    },
    onCompliance: () => {
      updateJob(job.id, { status: STATUS.CHECKING, message: '준수 검사에서 걸린 부분을 고쳐 쓰는 중...' });
    },
  });

  const charCount = countChars(post);
  const tableRows = post.table?.rows?.length || 0;
  const compliance = post.compliance;
  const research = post.research;

  const notes = [`공백 제외 ${charCount.toLocaleString()}자`];
  if (research) notes.push(`검색 ${research.searches}회 · 출처 ${post.sources.length}건`);
  if (tableRows) {
    notes.push(post.tableExpected ? `표 ${tableRows}/${post.tableExpected}행` : `표 ${tableRows}행`);
  }
  if (post.tableMissing?.length) notes.push(`누락 ${post.tableMissing.length}건`);
  if (post.repairs) notes.push(`보정 ${post.repairs}회`);
  if (compliance) notes.push(summarize(compliance));

  updateJob(job.id, {
    title: post.title,
    charCount,
    tableRows,
    model: post.model,
    guidelineCheck: post.guidelineCheck,
    compliance,
    repairs: post.repairs || 0,
    searches: research?.searches || 0,
    sourceCount: post.sources?.length || 0,
    unverified: research?.unverified?.length || 0,
    message: `초안 완성 (${notes.join(', ')})`,
  });
  logger.info(
    `[${job.topic}] 초안 완성: "${post.title}" — ${notes.join(', ')}`
    + `${post.model ? ` / 모델 ${post.model}` : ''}`,
    { jobId: job.id },
  );
  if (post.guidelineCheck) {
    logger.info(`[${job.topic}] 지침 반영: ${post.guidelineCheck}`, { jobId: job.id });
  }
  if (research?.unverified?.length) {
    logger.warn(
      `[${job.topic}] 조사에서 확인하지 못한 내용 ${research.unverified.length}건이 있습니다. `
      + `발행 전에 확인하세요: ${research.unverified.slice(0, 3).join(' / ')}`,
      { jobId: job.id },
    );
  }

  // 끝내 규칙을 못 지킨 글을 올리지 않도록 막을 수 있다. 기본값은 "올리되 표시만".
  if (compliance && !compliance.ok) {
    const detail = compliance.issues.map((issue) => `${issue.label}(${issue.detail})`).join(' / ');
    if (settings.adsense.blockOnFail) {
      throw new Error(`애드센스 준수 검사 미통과로 저장하지 않았습니다: ${detail}`);
    }
    logger.warn(`[${job.topic}] 준수 미통과 항목이 남아 있습니다: ${detail}`, { jobId: job.id });
  }

  updateJob(job.id, { status: STATUS.THUMBNAIL, message: '썸네일 만드는 중...' });
  let thumb = { filePath: '', fileName: '', style: '' };
  try {
    thumb = await renderThumbnail(post, { jobId: job.id });
    updateJob(job.id, { thumbnailPath: thumb.fileName, message: `썸네일 완성 (${thumb.style})` });
  } catch (error) {
    // 썸네일은 글의 부속물이다. 여기서 실패했다고 글을 버리지 않는다.
    logger.warn(`[${job.topic}] 썸네일 생성 실패, 글만 저장합니다: ${error.message}`, { jobId: job.id });
  }

  const dir = archivePost(job, post, thumb.filePath);

  updateJob(job.id, { status: STATUS.POSTING, message: '워드프레스에 임시저장하는 중...' });
  const result = await saveDraft({
    post,
    thumbnailPath: thumb.filePath,
    jobId: job.id,
    signal: state.abort?.signal,
  });

  updateJob(job.id, {
    status: STATUS.DONE,
    message: compliance?.ok
      ? '임시저장 완료 (준수 검사 통과)'
      : `임시저장 완료 (${summarize(compliance)})`,
    archiveDir: path.basename(dir),
    editUrl: result.editUrl || '',
    postUrl: result.previewUrl || '',
  });
  logger.info(
    `[${job.topic}] 임시저장 완료 (글 ID ${result.id})${result.editUrl ? ` → ${result.editUrl}` : ''}`,
    { jobId: job.id },
  );
}

// 같은 이유로 계속 실패할 때 남은 주제를 전부 태우지 않도록 하는 한계선.
/**
 * 실패 메시지가 길면 작업표가 글로 뒤덮인다.
 * (AI 가 주제를 거절하면 이유를 몇 문단씩 적어 보낸다)
 * 표에는 짧게 띄우고 전체 내용은 따로 담아 마우스를 올렸을 때 보이게 한다.
 */
function shorten(message, max = 160) {
  const text = String(message).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function loop() {
  let processed = 0;
  let consecutiveFailures = 0;

  while (state.running) {
    if (state.paused) {
      await sleep(700);
      continue;
    }

    const job = nextPending();
    if (!job) {
      logger.info('대기 중인 주제가 없습니다. 실행을 마칩니다.');
      break;
    }

    try {
      await processJob(job);
      consecutiveFailures = 0;
    } catch (error) {
      const message = error.message || String(error);

      // 사용량 한도는 계속 돌려도 전부 실패한다. 멈추고 사람이 판단하게 둔다.
      if (error.rateLimited) {
        updateJob(job.id, { status: STATUS.PENDING, message: `사용량 한도로 대기: ${message}` });
        state.paused = true;
        logger.error(`사용량 한도에 걸려 일시정지했습니다. 잠시 뒤 [이어서 실행]을 눌러주세요. ${message}`);
        broadcast();
        continue;
      }

      // AI 가 "이 주제로는 못 쓰겠다" 고 거절한 경우다.
      // 같은 주제로 다시 물어봐야 같은 대답이 온다. 재시도는 호출만 버리는 짓이고,
      // 설정이 잘못된 것도 아니니 연속 실패로 세지도 않는다. 바로 다음 주제로 간다.
      if (error.refusal) {
        updateJob(job.id, {
          status: STATUS.SKIPPED,
          message: `AI가 이 주제를 거절했습니다: ${shorten(error.reason || message)}`,
          detail: String(error.reason || message),
        });
        logger.warn(
          `[${job.topic}] AI가 이 주제를 거절해 건너뜁니다. ${shorten(error.reason || message, 200)}`,
          { jobId: job.id },
        );
        continue;
      }

      consecutiveFailures += 1;
      const canRetry = job.attempts <= getSettings().run.maxRetries;
      if (canRetry && state.running) {
        updateJob(job.id, {
          status: STATUS.PENDING,
          message: `실패, 재시도 예정: ${shorten(message)}`,
          detail: message,
        });
        logger.warn(`[${job.topic}] 실패 - 재시도합니다. ${shorten(message, 200)}`, { jobId: job.id });
        await sleep(5000);
      } else {
        updateJob(job.id, { status: STATUS.FAILED, message: shorten(message), detail: message });
        logger.error(`[${job.topic}] 실패: ${shorten(message, 200)}`, { jobId: job.id });
      }

      // 설정이 잘못됐거나 연결이 끊긴 상태라면 남은 주제도 전부 같은 이유로 실패한다.
      // 그래도 기본값은 "멈추지 않고 계속" 이다. 한두 주제가 안 된다고 나머지
      // 아흔 몇 건을 세워두는 것보다, 끝까지 돌려놓고 실패한 것만 다시 보는 편이 낫다.
      // 설정에서 0 이 아닌 값을 주면 그 횟수만큼 연속 실패했을 때 멈춘다.
      const stopAfter = Number(getSettings().run.stopAfterFailures) || 0;
      if (stopAfter > 0 && consecutiveFailures >= stopAfter) {
        logger.error(
          `연속 ${consecutiveFailures}건이 실패해 실행을 멈춥니다. `
          + `마지막 오류: ${shorten(message, 200)}`,
        );
        state.running = false;
      }
    } finally {
      state.currentJobId = null;
      broadcast();
    }

    processed += 1;
    if (!state.running) break;
    if (!nextPending()) break;

    // 짧은 시간에 몰아서 올리면 호스팅의 요청 제한에 걸릴 수 있다. 사이를 띄운다.
    const { delayMinSec, delayMaxSec } = getSettings().run;
    const wait = randomBetween(
      Math.max(0, delayMinSec) * 1000,
      Math.max(delayMinSec, delayMaxSec) * 1000,
    );
    state.waitUntil = Date.now() + wait;
    broadcast();
    logger.info(`다음 글까지 ${Math.round(wait / 1000)}초 대기합니다.`);

    const until = Date.now() + wait;
    while (Date.now() < until && state.running) await sleep(500);
    state.waitUntil = null;
  }

  state.running = false;
  state.paused = false;
  state.currentJobId = null;
  state.waitUntil = null;
  broadcast();
  logger.info(`실행 종료. 이번 실행에서 ${processed}건 처리했습니다.`);
}

export function start() {
  if (state.running) return { ok: false, message: '이미 실행 중입니다.' };
  if (!nextPending()) return { ok: false, message: '대기 중인 주제가 없습니다.' };

  const site = readSiteInfo();
  if (!site.connected) {
    return { ok: false, message: '먼저 워드프레스 연결을 확인해 주세요. (1번 칸의 [연결 확인])' };
  }
  if (!site.canPublish) {
    return { ok: false, message: '이 계정에는 글쓰기 권한이 없습니다. 권한이 있는 계정으로 바꿔 주세요.' };
  }

  state.running = true;
  state.paused = false;
  state.abort = new AbortController();
  broadcast();
  logger.info(`실행 시작 - 대기 ${stats().pending}건`);
  loop().catch((error) => {
    logger.error(`실행 루프 오류: ${error.message}`);
    state.running = false;
    broadcast();
  });
  return { ok: true };
}

export function pause() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.paused = !state.paused;
  broadcast();
  logger.info(state.paused ? '일시정지했습니다.' : '다시 시작합니다.');
  return { ok: true, paused: state.paused };
}

export function stop() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.running = false;
  state.paused = false;
  state.abort?.abort();
  broadcast();
  logger.info('중지 요청을 받았습니다. 진행 중인 글을 마치고 멈춥니다.');
  return { ok: true };
}
