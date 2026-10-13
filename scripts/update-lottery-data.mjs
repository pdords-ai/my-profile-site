// 동행복권 당첨번호를 data/lotto.json, data/pension.json 으로 수집한다.
// 사용: node scripts/update-lottery-data.mjs   (Node 20+, 외부 의존성 없음)
//
// 동행복권 사이트(2025~ 개편)가 화면에서 쓰는 내부 JSON 엔드포인트를 사용한다.
// 공개 API가 아니므로 응답 형식이 바뀌면 이 스크립트가 실패한다(기존 데이터는 보존).

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.DHLOTTERY_BASE || 'https://www.dhlottery.co.kr';
const DATA_DIR = new URL('../data/', import.meta.url);
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const LOTTO_FIRST_DRAW = Date.UTC(2002, 11, 7); // 제1회 로또 추첨일 (2002-12-07)
const DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, referer) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE}/${referer}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (!type.includes('json')) throw new Error(`unexpected content-type ${type}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error(`${path}: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function readExisting(name) {
  try {
    return JSON.parse(await readFile(new URL(name, DATA_DIR), 'utf8')).draws || [];
  } catch {
    return [];
  }
}

// 당첨번호가 바뀌었을 때만 쓴다 (updatedAt만 바뀐 커밋이 생기지 않도록)
async function save(name, draws) {
  draws.sort((a, b) => a.round - b.round);
  const existing = await readExisting(name);
  if (JSON.stringify(existing) === JSON.stringify(draws)) return;
  const body = { source: BASE, updatedAt: new Date().toISOString(), draws };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL(name, DATA_DIR), JSON.stringify(body) + '\n');
}

// ---- 로또 6/45 ----
function toLottoDraw(it) {
  const numbers = [it.tm1WnNo, it.tm2WnNo, it.tm3WnNo, it.tm4WnNo, it.tm5WnNo, it.tm6WnNo].map(Number).sort((a, b) => a - b);
  const draw = { round: Number(it.ltEpsd), date: ymd(String(it.ltRflYmd)), numbers, bonus: Number(it.bnsWnNo) };
  const all = [...numbers, draw.bonus];
  if (!Number.isInteger(draw.round) || all.some((n) => !Number.isInteger(n) || n < 1 || n > 45) || new Set(all).size !== 7) {
    throw new Error(`invalid lotto row: ${JSON.stringify(it)}`);
  }
  return draw;
}

async function lottoList(query) {
  await sleep(DELAY_MS);
  const json = await getJson(`/lt645/selectPstLt645InfoNew.do?${query}`, 'lt645/result');
  return (json?.data?.list || []).map(toLottoDraw);
}

async function updateLotto() {
  const byRound = new Map((await readExisting('lotto.json')).map((d) => [d.round, d]));
  const before = byRound.size;
  const known = before ? Math.max(...byRound.keys()) : 0;

  // 최신 회차 찾기: 날짜로 추정한 회차 근처를 조회하고, 더 큰 회차가 안 나올 때까지 앞으로 이동
  let probe = Math.floor((Date.now() - LOTTO_FIRST_DRAW) / (7 * 86400000)) + 1;
  let latest = 0;
  for (let i = 0; i < 20; i++) {
    const list = await lottoList(`srchDir=center&srchLtEpsd=${probe}`);
    list.forEach((d) => byRound.set(d.round, d));
    const max = list.length ? Math.max(...list.map((d) => d.round)) : 0;
    if (!list.length) { probe -= 5; continue; }
    if (max <= latest) break;
    latest = max;
    probe = max + 5;
  }
  if (!latest) throw new Error('could not determine latest lotto round');

  // 커서를 뒤로 옮기며 이미 가진 회차에 닿을 때까지(처음이면 1회까지) 수집
  let cursor = Math.min(...[...byRound.keys()].filter((r) => r > known));
  while (cursor > known + 1) {
    const list = await lottoList(`srchDir=older&srchCursorLtEpsd=${cursor}`);
    if (!list.length) break;
    list.forEach((d) => byRound.set(d.round, d));
    const min = Math.min(...list.map((d) => d.round));
    if (min >= cursor) break;
    cursor = min;
  }

  const draws = [...byRound.values()];
  const missing = [];
  for (let r = 1; r <= latest; r++) if (!byRound.has(r)) missing.push(r);
  if (missing.length) throw new Error(`lotto rounds missing: ${missing.slice(0, 20).join(',')}${missing.length > 20 ? '…' : ''}`);

  await save('lotto.json', draws);
  console.log(`lotto: ${draws.length} draws (latest ${latest}, +${draws.length - before})`);
}

// ---- 연금복권720+ ----
async function updatePension() {
  const before = (await readExisting('pension.json')).length;
  const json = await getJson('/pt720/selectPstPt720WnList.do', 'pt720/result');
  const rows = json?.data?.result || [];
  const draws = rows.map((it) => {
    const draw = {
      round: Number(it.psltEpsd),
      date: ymd(String(it.psltRflYmd)),
      group: Number(it.wnBndNo),
      number: String(it.wnRnkVl),
      bonus: String(it.bnsRnkVl),
    };
    if (!Number.isInteger(draw.round) || !(draw.group >= 1 && draw.group <= 5) || !/^\d{6}$/.test(draw.number) || !/^\d{6}$/.test(draw.bonus)) {
      throw new Error(`invalid pension row: ${JSON.stringify(it)}`);
    }
    return draw;
  });
  if (!draws.length) throw new Error('empty pension list');
  const latest = Math.max(...draws.map((d) => d.round));
  if (draws.length !== latest) throw new Error(`pension rounds missing: got ${draws.length}, latest ${latest}`);
  if (draws.length < before) throw new Error(`pension list shrank: ${before} -> ${draws.length}`);

  await save('pension.json', draws);
  console.log(`pension: ${draws.length} draws (latest ${latest}, +${draws.length - before})`);
}

// 한쪽이 실패해도 다른 쪽은 저장하고, 실패가 있으면 종료 코드 1
const results = await Promise.allSettled([updateLotto(), updatePension()]);
let failed = false;
for (const r of results) {
  if (r.status === 'rejected') {
    failed = true;
    console.error(r.reason);
  }
}
process.exit(failed ? 1 : 0);
