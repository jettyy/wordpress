import { prepareBrowser } from '../src/lib/playwright.js';
import { checkClaude } from '../src/ai/claude.js';
import { getSettings } from '../src/lib/settings.js';
import { verifyConnection } from '../src/wordpress/client.js';

console.log('워프러시 준비 상태를 확인합니다.\n');

const claude = await checkClaude();
console.log(claude.ok
  ? `[확인] claude CLI: ${claude.version}`
  : `[실패] claude CLI: ${claude.message}\n`
    + "       npm install -g @anthropic-ai/claude-code 로 설치한 뒤 'claude' 를 한 번 실행해 로그인하세요.");

try {
  const { label } = await prepareBrowser();
  console.log(`[확인] 썸네일 렌더러: ${label}`);
} catch (error) {
  console.log(`[실패] 썸네일 렌더러 준비 실패: ${error.message}`);
}

const { site } = getSettings();
if (!site.url || !site.username || !site.appPassword) {
  console.log('[대기] 워드프레스 연결 정보가 아직 없습니다. 대시보드 1번 칸에서 입력하세요.');
} else {
  const info = await verifyConnection();
  console.log(info.connected
    ? `[확인] 워드프레스: ${info.siteName || info.site} · ${info.userName} (${info.roles.join(', ')})`
    : `[실패] 워드프레스: ${info.message}`);
}

console.log('\n준비가 끝났으면 npm start 로 대시보드를 실행하세요.');
