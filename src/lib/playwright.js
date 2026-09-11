import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { logger } from './events.js';
import { getSettings } from './settings.js';

/**
 * 워드프레스판은 브라우저로 로그인하지 않는다. REST API 로 바로 올리기 때문이다.
 * 브라우저는 오직 하나, **썸네일 PNG 를 찍기 위한 헤드리스 렌더링**에만 쓴다.
 * 그래서 크롬 채널이나 로그인 프로필 같은 장치가 필요 없다.
 */

let installPromise = null;

/** 이미 설치된 크롬/크로미움을 쓰고 싶을 때의 탈출구. */
export function chromiumOverride() {
  const configured = getSettings().run?.chromiumPath || process.env.CHROMIUM_PATH || '';
  if (configured && fs.existsSync(configured)) return configured;
  if (configured) logger.warn(`지정한 크로미움 경로를 찾을 수 없습니다: ${configured}`);
  return '';
}

/**
 * 크로미움이 없으면 자동으로 받아온다. (사용자가 따로 명령을 칠 필요 없게)
 * 이미 설치돼 있으면 아무 것도 하지 않는다.
 */
export function ensureBrowsers() {
  if (installPromise) return installPromise;

  installPromise = (async () => {
    const override = chromiumOverride();
    if (override) {
      logger.info(`지정된 브라우저를 사용합니다: ${override}`);
      return true;
    }

    let executable = '';
    try {
      executable = chromium.executablePath();
    } catch {
      executable = '';
    }
    if (executable && fs.existsSync(executable)) {
      logger.info('썸네일용 크로미움 확인 완료.');
      return true;
    }

    logger.info('크로미움이 없어 자동으로 설치합니다. 처음 한 번은 몇 분 걸릴 수 있습니다...');
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['--yes', 'playwright', 'install', 'chromium'],
        { stdio: 'inherit', shell: process.platform === 'win32' },
      );
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`playwright install chromium 실패 (종료 코드 ${code})`));
      });
    });
    logger.info('크로미움 설치 완료.');
    return true;
  })().catch((error) => {
    installPromise = null;
    throw error;
  });

  return installPromise;
}

/** 썸네일을 찍을 수 있는 상태인지 확인한다. */
export async function prepareBrowser() {
  const override = chromiumOverride();
  if (override) return { using: override, label: '지정한 브라우저' };
  await ensureBrowsers();
  return { using: 'chromium', label: 'Playwright 크로미움' };
}

let renderBrowser = null;

/** 썸네일 스크린샷 전용 헤드리스 브라우저. */
export async function getRenderBrowser() {
  if (renderBrowser?.isConnected()) return renderBrowser;
  const override = chromiumOverride();
  if (!override) await ensureBrowsers();
  renderBrowser = await chromium.launch(
    override ? { headless: true, executablePath: override } : { headless: true },
  );
  return renderBrowser;
}

export async function closeRenderBrowser() {
  if (renderBrowser?.isConnected()) await renderBrowser.close();
  renderBrowser = null;
}
