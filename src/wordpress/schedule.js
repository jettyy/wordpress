/**
 * 발행 시각 계산.
 *
 * 글 100편을 한꺼번에 쏟아내면 사람이 쓴 블로그로 보이지 않는다.
 * 그래서 정해진 간격으로 하나씩 나가게 하고, 거기에 무작위 시간을 조금 더한다.
 * 매번 정확히 3시간마다 올라오는 것도 자동화 티가 나기 때문이다.
 *
 * 실제 발행은 **워드프레스가 알아서** 한다. 이 프로그램은 글을 올릴 때
 * "이 시각에 발행해라"(status=future)고 적어 보낼 뿐이다.
 * 그래서 예약을 걸어둔 뒤 컴퓨터를 꺼도 글은 제때 나간다.
 *
 * 여기 함수들은 전부 순수 함수다. 시각과 무작위값을 인자로 받아서
 * 검사 스크립트가 흔들림 없이 확인할 수 있게 했다.
 */

const MINUTE = 60 * 1000;

/** 'HH:mm' 을 {hour, minute} 으로. 못 읽으면 fallback. */
export function parseClock(text, fallback = { hour: 0, minute: 0 }) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!matched) return fallback;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return fallback;
  return { hour, minute };
}

/** 같은 날짜의 특정 시각. (컴퓨터의 현지 시간 기준) */
function atClock(date, { hour, minute }) {
  const out = new Date(date);
  out.setHours(hour, minute, 0, 0);
  return out;
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * 발행 시간대 밖이면 안으로 끌어온다.
 *
 * 새벽 4시에 글이 올라오면 사람이 쓴 블로그처럼 보이지 않는다.
 * 창보다 이르면 그날 시작 시각으로, 늦으면 다음 날 시작 시각으로 민다.
 */
export function clampToWindow(date, window) {
  if (!window?.enabled) return date;

  const from = parseClock(window.from, { hour: 8, minute: 0 });
  const to = parseClock(window.to, { hour: 23, minute: 0 });

  const start = atClock(date, from);
  const end = atClock(date, to);

  // 끝이 시작보다 빠르면(예: 22:00~02:00) 하루를 넘기는 창이다.
  // 이 경우는 다루지 않고 창이 없는 것으로 본다. 설정 화면에서 막아 두었다.
  if (end <= start) return date;

  if (date < start) return start;
  if (date > end) return atClock(addDays(date, 1), from);
  return date;
}

/**
 * 다음 글을 언제 발행할지 정한다.
 *
 * @param {object}      options
 * @param {Date}        options.now      지금 시각
 * @param {Date|null}   options.lastAt   앞서 예약해 둔 마지막 발행 시각
 * @param {object}      options.publish  설정의 publish 묶음
 * @param {() => number} [options.random] 0~1 난수 (검사할 때 고정값을 넣는다)
 * @returns {Date}
 */
export function computePublishAt({ now, lastAt, publish, random = Math.random }) {
  const interval = Math.max(0, Number(publish.intervalMinutes) || 0);
  const extraMax = Math.max(0, Number(publish.randomExtraMinutes) || 0);
  const extra = Math.round(random() * extraMax);

  let base;
  if (lastAt && lastAt.getTime() > now.getTime()) {
    // 이미 예약해 둔 글이 있으면 그 뒤로 줄을 세운다.
    base = new Date(lastAt.getTime() + (interval + extra) * MINUTE);
  } else {
    const first = parseClock(publish.startAt, null);
    if (first) {
      // 첫 글 시각을 정해 뒀다. 오늘 그 시각이 지났으면 내일로.
      const todayAt = atClock(now, first);
      base = todayAt.getTime() > now.getTime() ? todayAt : atClock(addDays(now, 1), first);
      base = new Date(base.getTime() + extra * MINUTE);
    } else {
      base = new Date(now.getTime() + (interval + extra) * MINUTE);
    }
  }

  return clampToWindow(base, publish.window);
}

/**
 * 워드프레스에 보낼 상태와 시각을 정한다.
 *
 * 예약 시각이 이미 지났으면 future 로 보내 봐야 소용없다.
 * (워드프레스가 "예약했는데 시간이 지난 글" 로 잡아두고 안 내보내는 일이 있다)
 * 그럴 때는 그냥 바로 발행한다.
 *
 * @returns {{status: 'draft'|'publish'|'future', dateGmt: string, at: Date|null}}
 */
export function resolvePublishTarget({ now, lastAt, publish, random }) {
  if (publish.mode !== 'publish') return { status: 'draft', dateGmt: '', at: null };

  if (publish.timing === 'now') return { status: 'publish', dateGmt: '', at: null };

  const at = computePublishAt({ now, lastAt, publish, random });
  if (at.getTime() <= now.getTime() + 30 * 1000) {
    return { status: 'publish', dateGmt: '', at: null };
  }
  // 사이트 시간대를 몰라도 되도록 UTC(date_gmt)로 보낸다.
  // 워드프레스가 사이트 시간대에 맞춰 표시용 시각을 계산해 준다.
  return { status: 'future', dateGmt: at.toISOString().replace(/\.\d{3}Z$/, ''), at };
}

/** 사람이 읽을 발행 예정 시각. */
export function formatPublishAt(date) {
  if (!date) return '';
  return date.toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
