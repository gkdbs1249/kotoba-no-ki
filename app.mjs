import {
  normalizeAnswer,
  normalizeDailyWordCount,
  isAcceptedAnswer,
  scoreDiagnostic,
  assignDailyWords,
  recordRecallAttempt,
  getRecallQueue,
  scheduleReviews,
  getDueWordIds,
  completeDueReview,
  buildMonthGrid,
  getDayStatus,
  isCalendarInactiveDate,
  selectPracticeBatch,
  getLearnedWordIds,
  selectCumulativeReviewIds,
  createInitialProgress,
  loadProgress,
  saveProgress,
} from './src/core.mjs';
import { createCloudSync, createFirebaseAdapters } from './src/cloud-sync.mjs';

const app = document.querySelector('#app');
const homeButton = document.querySelector('#home-button');
const accountButton = document.querySelector('#account-button');
const accountDialog = document.querySelector('#account-dialog');
const accountForm = document.querySelector('#account-form');
const accountMessage = document.querySelector('#account-message');
const signOutButton = document.querySelector('#sign-out-button');
const dailyWordCountForm = document.querySelector('#daily-word-count-form');
const dailyWordCountInput = document.querySelector('#daily-word-count');
const settingsMessage = document.querySelector('#settings-message');
const syncStatus = document.querySelector('#sync-status');
const SKILL_LABELS = {
  vocabulary: '어휘', reading: '읽기', particle: '조사', conjugation: '활용', sentence: '문장',
};
let words = [];
let diagnostics = [];
let extraPracticeDrills = [];
let katakanaDrills = [];
let previousExtraQuestionIds = [];
let previousKatakanaQuestionIds = [];
let previousReviewWordIds = [];
let progress = loadProgress();
try { saveProgress(localStorage, progress); } catch { /* continue in memory if storage is unavailable */ }
let cloudSync = null;
let initialized = false;
let viewMode = 'loading';
let accountSettingsChanged = false;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));
const localDate = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};
const today = () => localDate();
const wordMap = () => new Map(words.map((word) => [word.id, word]));
const currentAccountId = () => cloudSync?.currentUid ? localStorage.getItem('kotoba-no-ki:account-id') : null;
const isValidDateString = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const normalizeProgressShape = (candidate) => {
  const base = createInitialProgress();
  const value = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const knownIds = words.length ? new Set(words.map((word) => word.id)) : null;
  const validWordIds = (ids) => [...new Set((Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && (!knownIds || knownIds.has(id))))];
  const days = {};
  if (value.days && typeof value.days === 'object' && !Array.isArray(value.days)) {
    for (const [date, entry] of Object.entries(value.days)) {
      if (!isValidDateString(date) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const wordIds = validWordIds(entry.wordIds);
      const recallAttempts = (Array.isArray(entry.recallAttempts) ? entry.recallAttempts : [])
        .filter((attempt) => attempt && typeof attempt === 'object' && !Array.isArray(attempt))
        .map((attempt) => ({
          ...attempt,
          wordIds: validWordIds(attempt.wordIds),
          results: (Array.isArray(attempt.results) ? attempt.results : [])
            .filter((result) => result && typeof result === 'object' && validWordIds([result.wordId]).length)
            .map((result) => ({ ...result, correct: Boolean(result.correct) })),
          completed: Boolean(attempt.completed),
        }));
      days[date] = {
        ...entry,
        date,
        wordIds,
        recallAttempts,
        learned: Boolean(entry.learned),
        coverageComplete: Boolean(entry.coverageComplete && wordIds.length),
      };
    }
  }
  const reviews = {};
  if (value.reviews && typeof value.reviews === 'object' && !Array.isArray(value.reviews)) {
    for (const [wordId, review] of Object.entries(value.reviews)) {
      if (!validWordIds([wordId]).length || !review || typeof review !== 'object' || Array.isArray(review) || !isValidDateString(review.learnedDate)) continue;
      reviews[wordId] = {
        ...review,
        completedIntervals: [...new Set((Array.isArray(review.completedIntervals) ? review.completedIntervals : [])
          .filter((interval) => [1, 3, 7, 14, 30, 60].includes(interval)))],
      };
    }
  }
  const diagnostic = value.diagnostic && typeof value.diagnostic === 'object' && !Array.isArray(value.diagnostic)
    ? { ...value.diagnostic, weakSkills: (Array.isArray(value.diagnostic.weakSkills) ? value.diagnostic.weakSkills : []).filter((skill) => SKILL_LABELS[skill]) }
    : undefined;
  const sourceSettings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {};
  const settings = {
    dailyWordCount: normalizeDailyWordCount(sourceSettings.dailyWordCount),
    revision: Number.isInteger(sourceSettings.revision) && sourceSettings.revision >= 0 ? sourceSettings.revision : 0,
  };
  return {
    ...base,
    ...value,
    studyStartDate: isValidDateString(value.studyStartDate) ? value.studyStartDate : base.studyStartDate,
    ...(diagnostic ? { diagnostic } : {}),
    settings,
    days,
    reviews,
  };
};
const persist = () => {
  progress.updatedAt = new Date().toISOString();
  if (cloudSync) {
    cloudSync.save(progress).catch(() => { syncStatus.textContent = '오프라인 · 기기에 저장됨'; });
  } else {
    try {
      saveProgress(localStorage, progress);
    } catch {
      syncStatus.textContent = '저장 실패 · 창을 닫지 마세요';
    }
  }
};
const setView = (html, mode = 'active') => {
  window.speechSynthesis?.cancel();
  viewMode = mode;
  app.innerHTML = html;
  const accountAvailable = ['welcome', 'dashboard'].includes(mode);
  accountButton.disabled = !accountAvailable;
  accountButton.title = accountAvailable ? '' : '학습 화면을 마친 뒤 계정을 연결할 수 있어요';
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
};
const progressBar = (current, total) => `<div class="progress" aria-label="${current}/${total}"><span style="width:${total ? current / total * 100 : 0}%"></span></div>`;

function updateAccountUi() {
  const authAvailable = Boolean(cloudSync);
  const signedIn = Boolean(cloudSync?.currentUid);
  const rememberedId = localStorage.getItem('kotoba-no-ki:account-id');
  accountButton.textContent = signedIn ? (rememberedId || '계정 연결됨') : authAvailable ? '로그인' : '설정';
  accountForm.classList.toggle('hidden', signedIn || !authAvailable);
  signOutButton.classList.toggle('hidden', !signedIn);
}

async function setupCloudSync() {
  try {
    const [{ firebaseConfig }, appSdk, authSdk, firestoreSdk] = await Promise.all([
      import('./firebase-config.mjs'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js'),
    ]);
    const firebaseApp = appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(firebaseConfig);
    const adapters = createFirebaseAdapters({
      authSdk,
      firestoreSdk,
      authInstance: authSdk.getAuth(firebaseApp),
      db: firestoreSdk.getFirestore(firebaseApp),
    });
    cloudSync = createCloudSync({
      ...adapters,
      storage: localStorage,
      shouldDeferRemote: () => viewMode === 'active',
      applyState: (next, meta = {}) => {
        progress = normalizeProgressShape(next);
        updateAccountUi();
        if (initialized && meta.reason === 'profile' && viewMode === 'active') {
          if (accountDialog.open) accountDialog.close();
          progress.diagnostic?.completed ? renderDashboard() : renderWelcome();
          return;
        }
        if (initialized && ['welcome', 'dashboard'].includes(viewMode)) {
          progress.diagnostic?.completed ? renderDashboard() : renderWelcome();
        }
      },
      onStatus: (status) => {
        syncStatus.textContent = ({ syncing: '동기화 중…', synced: '클라우드에 저장됨', offline: '오프라인 · 기기에 저장됨', 'storage-error': '기기 저장 실패 · 클라우드 재시도 중' })[status] || '기기에 저장됨';
      },
    });
    await cloudSync.start();
    accountButton.disabled = !['welcome', 'dashboard'].includes(viewMode);
    accountButton.title = accountButton.disabled ? '학습 화면을 마친 뒤 계정을 연결할 수 있어요' : '';
    updateAccountUi();
    syncStatus.textContent = cloudSync.currentUid ? '클라우드 연결됨' : '로그인하면 동기화';
  } catch {
    cloudSync = null;
    syncStatus.textContent = '이 기기에 저장됨';
    updateAccountUi();
    accountButton.disabled = !['welcome', 'dashboard'].includes(viewMode);
    accountButton.title = accountButton.disabled ? '학습 화면을 마친 뒤 설정할 수 있어요' : '';
  }
}

function speakJapanese(text, button) {
  if (!('speechSynthesis' in window)) {
    button.textContent = '이 기기에서는 음성을 사용할 수 없어요';
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = 0.86;
  const voice = speechSynthesis.getVoices().find((item) => item.lang?.toLowerCase().startsWith('ja'));
  if (voice) utterance.voice = voice;
  button.setAttribute('aria-pressed', 'true');
  utterance.onend = utterance.onerror = () => button.setAttribute('aria-pressed', 'false');
  speechSynthesis.speak(utterance);
}

function renderWelcome() {
  if (cloudSync?.applyDeferred()) return renderWelcome();
  setView(`<section class="panel">
    <p class="eyebrow">내 일본어의 뿌리부터 확인해요</p>
    <h1>N5 배치 진단</h1>
    <p>어휘·읽기·조사·활용·문장, 총 30문항이에요.</p>
    <p class="muted">약한 영역을 찾아 앞으로의 학습에 반영해요. 진단 점수는 일일 기록에 포함되지 않아요.</p>
    <button class="primary" id="start-diagnostic" type="button">30문항 진단 시작</button>
  </section>`, 'welcome');
  document.querySelector('#start-diagnostic').addEventListener('click', () => runQuestionSession(diagnostics, finishDiagnostic));
}

function answerMatches(question, answer) {
  if (Array.isArray(question.answer)) {
    return Array.isArray(answer) && question.answer.map(normalizeAnswer).join('|') === answer.map(normalizeAnswer).join('|');
  }
  return normalizeAnswer(answer) === normalizeAnswer(question.answer);
}

function runQuestionSession(questions, onComplete, options = {}) {
  let index = 0;
  const responses = {};
  const render = () => {
    const question = questions[index];
    let selectedOrder = [];
    const title = options.title ?? 'N5 배치 진단';
    const instruction = question.responseMode === 'ordering' ? '알맞은 순서대로 눌러 주세요.' : '정답을 선택하거나 입력해 주세요.';
    const choices = question.choices ?? [];
    setView(`<section class="panel">
      <p class="eyebrow">${escapeHtml(title)} · ${index + 1}/${questions.length}</p>
      ${progressBar(index, questions.length)}
      <p class="muted">${escapeHtml(SKILL_LABELS[question.skill] ?? question.skill)} · ${instruction}</p>
      <div class="question">${escapeHtml(question.prompt)}</div>
      ${question.responseMode === 'typing' ? `<form class="answer-form"><label for="quiz-answer">일본어로 입력</label><input id="quiz-answer" name="answer" lang="ja" inputmode="text" autocomplete="off" enterkeyhint="done" required><button class="primary" type="submit">정답 확인</button></form>` : `<div class="choice-list">${choices.map((choice) => `<button class="choice" type="button" data-choice="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`).join('')}</div>${question.responseMode === 'ordering' ? '<button class="primary" id="order-submit" type="button" disabled>순서 확인</button><p id="order-preview" class="muted">선택한 순서: —</p>' : ''}`}
      <div id="feedback-slot"></div>
    </section>`);
    let answered = false;
    const submit = (answer) => {
      if (answered) return;
      answered = true;
      responses[question.id] = answer;
      const correct = answerMatches(question, answer);
      app.querySelectorAll('button[data-choice], .answer-form input, .answer-form button, #order-submit').forEach((control) => { control.disabled = true; });
      const canonical = Array.isArray(question.answer) ? question.answer.join(' → ') : question.answer;
      document.querySelector('#feedback-slot').innerHTML = `<div class="feedback ${correct ? 'correct' : 'wrong'}" role="status" aria-live="polite">
        ${correct ? '✓ 정답이에요!' : `✕ 아쉬워요. 정답: ${escapeHtml(canonical)}`}<br><span>${escapeHtml(question.explanationKo)}</span>
      </div><button class="primary" id="next-question" type="button">${index + 1 === questions.length ? '결과 보기' : '다음 문제'}</button>`;
      const next = document.querySelector('#next-question');
      next.focus();
      next.addEventListener('click', () => {
        index += 1;
        if (index >= questions.length) onComplete(responses, questions);
        else render();
      });
    };
    const form = app.querySelector('.answer-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (event.isComposing) return;
      submit(new FormData(form).get('answer'));
    });
    app.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', () => {
      if (question.responseMode === 'ordering') {
        if (button.disabled) return;
        selectedOrder.push(button.dataset.choice);
        button.disabled = true;
        document.querySelector('#order-preview').textContent = `선택한 순서: ${selectedOrder.join(' → ')}`;
        document.querySelector('#order-submit').disabled = selectedOrder.length !== choices.length;
      } else submit(button.dataset.choice);
    }));
    document.querySelector('#order-submit')?.addEventListener('click', () => submit(selectedOrder));
    document.querySelector('#quiz-answer')?.focus();
  };
  render();
}

function finishDiagnostic(responses, questions) {
  const result = scoreDiagnostic(questions, responses);
  progress.diagnostic = { ...result, completed: true, completedAt: new Date().toISOString(), responses };
  persist();
  setView(`<section class="panel">
    <p class="eyebrow">진단 완료</p><h1>${result.correct}/${result.total} 정답</h1>
    <p>${result.weakSkills.length ? '보완하면 좋을 영역을 찾았어요.' : 'N5 기초가 고르게 잘 잡혀 있어요!'}</p>
    <ul class="skill-list">${Object.entries(result.skills).map(([skill, value]) => `<li class="skill-row"><span>${escapeHtml(SKILL_LABELS[skill] ?? skill)}</span><strong>${value.correct}/${value.total} · ${Math.round(value.accuracy * 100)}%</strong></li>`).join('')}</ul>
    ${result.weakSkills.length ? `<p class="feedback wrong">집중 영역: ${result.weakSkills.map((skill) => escapeHtml(SKILL_LABELS[skill] ?? skill)).join(' · ')}</p>` : ''}
    <button class="primary" id="to-dashboard" type="button">오늘 학습으로</button>
  </section>`);
  document.querySelector('#to-dashboard').addEventListener('click', renderDashboard);
}

function dashboardCalendarMarkup() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const grid = buildMonthGrid(year, month);
  const statusLabels = { mastered: '떠올리기 완료', studied: '학습 중', missed: '학습 없음', today: '오늘', future: '미래 날짜', inactive: '학습 시작 전' };
  return `<section class="dashboard-calendar" aria-labelledby="dashboard-calendar-title">
    <p class="eyebrow">학습 캘린더</p><h2 id="dashboard-calendar-title">${year}년 ${month + 1}월</h2>
    <div class="calendar-wrap"><div class="weekdays" aria-hidden="true">${['일','월','화','수','목','금','토'].map((day) => `<div>${day}</div>`).join('')}</div><div class="calendar" aria-label="${year}년 ${month + 1}월">${grid.map((cell) => {
      if (!cell) return '<span class="day blank" aria-hidden="true"></span>';
      const status = isCalendarInactiveDate(currentAccountId(), cell.date)
        ? 'inactive'
        : getDayStatus(progress, cell.date, today(), progress.studyStartDate);
      return `<button class="day ${status}" type="button" data-calendar-date="${cell.date}" aria-label="${cell.date}, ${statusLabels[status]}">${cell.day}</button>`;
    }).join('')}</div></div>
    <div class="legend"><span class="mastered">떠올리기 완료</span><span class="studied">학습 중</span><span class="missed">학습 없음</span></div>
    <div id="dashboard-day-detail"></div>
  </section>`;
}

function bindDashboardCalendar() {
  document.querySelectorAll('[data-calendar-date]').forEach((button) => button.addEventListener('click', () => {
    const date = button.dataset.calendarDate;
    const day = progress.days[date];
    const inactive = isCalendarInactiveDate(currentAccountId(), date);
    document.querySelector('#dashboard-day-detail').innerHTML = inactive
      ? `<p class="muted">${date}은 코토바노키 업데이트 기간으로 학습 기록 대상에서 제외했어요.</p>`
      : day
      ? `<div class="calendar-detail"><h3>${date}</h3><p>단어 ${day.wordIds?.length ?? 0}개 · ${day.coverageComplete ? '뜻 → 일본어 완료' : '학습 중'}</p><p class="muted">완료한 입력 회차 ${day.recallAttempts?.filter((attempt) => attempt.completed).length ?? 0}회</p></div>`
      : `<p class="muted">${date}에는 저장된 학습이 없어요.</p>`;
  }));
}

function reviewCountOptions(total) {
  const defaultCount = Math.min(10, total);
  const choices = [5, 10, 20, 30, 50].filter((count) => count < total);
  return `${choices.map((count) => `<option value="${count}" ${count === defaultCount ? 'selected' : ''}>${count}개</option>`).join('')}<option value="${total}" ${total <= 10 ? 'selected' : ''}>전체 (${total}개)</option>`;
}

function renderDashboard() {
  if (cloudSync?.applyDeferred()) return renderDashboard();
  const date = today();
  const dailyWordCount = normalizeDailyWordCount(progress.settings?.dailyWordCount);
  const previousToday = progress.days[date];
  let assignedDay = previousToday;
  const emptyToday = previousToday
    && (!Array.isArray(previousToday.wordIds) || previousToday.wordIds.length === 0)
    && !previousToday.learned
    && !previousToday.coverageComplete
    && !(previousToday.learnedWordIds?.length)
    && !(previousToday.coveredWordIds?.length)
    && !(previousToday.recallAttempts?.length);
  if (emptyToday) {
    assignedDay = assignDailyWords(progress, words, date, dailyWordCount);
    if (progress.days[date] !== previousToday) persist();
  }
  const pendingDay = Object.values(progress.days)
    .filter((entry) => Array.isArray(entry?.wordIds) && entry.wordIds.length > 0 && !entry.coverageComplete)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const day = assignedDay?.wordIds?.length ? assignedDay : pendingDay ?? assignedDay;
  const due = getDueWordIds(progress, date).length;
  const byId = wordMap();
  const learnedReviewIds = getLearnedWordIds(progress).filter((id) => byId.has(id));
  const reviewTotal = learnedReviewIds.length;
  const completedDays = Object.values(progress.days).filter((entry) => entry.coverageComplete).length;
  const n5Words = words.filter((word) => word.level === 'N5');
  const completedN5 = new Set(Object.values(progress.days)
    .filter((entry) => entry.coverageComplete)
    .flatMap((entry) => entry.wordIds ?? []));
  const currentLevel = n5Words.every((word) => completedN5.has(word.id)) ? 'N4 초급 확장' : 'N5 기초 다지기';
  const weakSkills = progress.diagnostic?.weakSkills ?? [];
  const displayedWordCount = day?.wordIds?.length ?? dailyWordCount;
  setView(`<section class="panel">
    <p class="eyebrow">${currentLevel} · 오늘도 한 가지씩 자라요</p><h1>안녕하세요 🌱</h1>
    ${weakSkills.length ? `<p class="muted">진단 추천: ${weakSkills.map((skill) => escapeHtml(SKILL_LABELS[skill] ?? skill)).join(' · ')} 영역을 먼저 보완해요.</p>` : ''}
    <div class="stats"><div class="stat"><strong>${displayedWordCount}</strong><span>오늘 단어</span></div><div class="stat"><strong>${reviewTotal}</strong><span>누적 복습</span></div><div class="stat"><strong>${completedDays}</strong><span>완료한 날</span></div></div>
    <div class="dashboard-grid">
      <article class="task"><div class="task-copy"><h2>오늘의 학습</h2><p>${day?.coverageComplete ? `오늘의 ${displayedWordCount}개를 모두 떠올렸어요` : day?.learned ? '뜻 → 일본어 오답을 줄여 보세요' : `새 단어 ${displayedWordCount}개와 직접 입력`}</p></div><button id="daily-button" type="button">${day?.coverageComplete ? '다시 보기' : '시작'}</button></article>
      <article class="task review-task"><div class="task-copy"><h2>복습</h2><p>지금까지 배운 ${reviewTotal}개 누적 · 오늘 예정 ${due}개</p></div>${reviewTotal ? `<div class="review-controls"><label for="review-count">이번 복습</label><select id="review-count">${reviewCountOptions(reviewTotal)}</select><button id="review-button" type="button">시작</button></div>` : '<button id="review-button" type="button" disabled>배운 뒤 가능</button>'}</article>
      <article class="task"><div class="task-copy"><h2>추가 연습</h2><p>조사·활용 / 가타카나 빠르게 읽기</p></div><button id="extra-button" type="button">선택</button></article>
    </div>
    ${dashboardCalendarMarkup()}
  </section>`, 'dashboard');
  document.querySelector('#daily-button').addEventListener('click', startDaily);
  document.querySelector('#review-button').addEventListener('click', () => startReview(Number(document.querySelector('#review-count')?.value ?? 0)));
  document.querySelector('#extra-button').addEventListener('click', renderExtraPracticeHub);
  bindDashboardCalendar();
}

function renderExtraPracticeHub() {
  setView(`<section class="panel"><p class="eyebrow">정규 진도와 별도</p><h1>추가 연습</h1><p class="muted">연습 결과는 오늘의 학습·복습·캘린더에 저장되지 않아요.</p><div class="dashboard-grid">
    <article class="task"><div class="task-copy"><h2>조사·활용</h2><p>50문제 중 매번 다른 10문제</p></div><button id="extra-particle-button" type="button">연습</button></article>
    <article class="task"><div class="task-copy"><h2>가타카나 빠르게 읽기</h2><p>50문제 중 매번 다른 10문제</p></div><button id="extra-katakana-button" type="button">연습</button></article>
  </div><button class="secondary" id="extra-practice-home" type="button">홈으로</button></section>`);
  document.querySelector('#extra-particle-button').addEventListener('click', startExtraPractice);
  document.querySelector('#extra-katakana-button').addEventListener('click', startKatakanaPractice);
  document.querySelector('#extra-practice-home').addEventListener('click', renderDashboard);
}

function startDaily() {
  const date = today();
  const day = assignDailyWords(progress, words, date, progress.settings.dailyWordCount);
  persist();
  if (!day.wordIds.length) {
    setView('<section class="panel"><h1>모든 준비된 단어를 배웠어요! 🎉</h1><button class="primary" id="done">홈으로</button></section>');
    document.querySelector('#done').addEventListener('click', renderDashboard);
    return;
  }
  if (day.learned && !day.coverageComplete) return startRecall(day);
  showLearningCards(day);
}

function showLearningCards(day) {
  let index = 0;
  const byId = wordMap();
  const render = () => {
    const word = byId.get(day.wordIds[index]);
    if (!word) return renderDataError('학습 단어를 찾지 못했어요.');
    setView(`<section class="panel word-card">
      <p class="eyebrow">새 단어 ${index + 1}/${day.wordIds.length}</p>${progressBar(index + 1, day.wordIds.length)}
      <ruby lang="ja">${escapeHtml(word.written)}<rt>${escapeHtml(word.reading)}</rt></ruby>
      <div class="meaning">${escapeHtml(word.meaningKo)}</div>
      <button class="speak" id="speak-word" type="button" aria-label="${escapeHtml(word.written)} 일본어 발음 듣기" aria-pressed="false">🔊 발음 듣기</button>
      <div class="example"><strong lang="ja">${escapeHtml(word.example?.japanese)}</strong><br><span class="muted">${escapeHtml(word.example?.reading)}</span><p>${escapeHtml(word.example?.korean)}</p></div>
      <button class="primary" id="next-card" type="button">${index + 1 === day.wordIds.length ? '직접 입력 연습' : '다음 단어'}</button>
    </section>`);
    document.querySelector('#speak-word').addEventListener('click', (event) => speakJapanese(word.written, event.currentTarget));
    document.querySelector('#next-card').addEventListener('click', () => {
      index += 1;
      if (index === day.wordIds.length) {
        day.learned = true;
        day.learnedWordIds = [...day.wordIds];
        scheduleReviews(progress, day.wordIds, day.date);
        persist();
        startRecall(day);
      } else render();
    });
  };
  render();
}

function startRecall(day) {
  let queue = getRecallQueue(day);
  if (!queue.length) return renderDailyComplete(day);
  const byId = wordMap();
  let index = 0;
  let roundResults = [];
  const render = () => {
    const word = byId.get(queue[index]);
    setView(`<section class="panel">
      <p class="eyebrow">뜻 → 일본어 · ${index + 1}/${queue.length}</p>${progressBar(index, queue.length)}
      <p class="muted">한자 또는 읽기(かな)로 입력해도 정답이에요.</p>
      <div class="question">${escapeHtml(word.meaningKo)}</div>
      <form class="answer-form"><label for="recall-answer">일본어 답</label><input id="recall-answer" lang="ja" autocomplete="off" enterkeyhint="done" required><button class="primary" type="submit">정답 확인</button></form>
      <div id="feedback-slot"></div>
    </section>`);
    const form = app.querySelector('.answer-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (event.isComposing || form.dataset.done) return;
      form.dataset.done = 'true';
      const input = document.querySelector('#recall-answer');
      const answer = input.value;
      const correct = isAcceptedAnswer(word, answer);
      input.disabled = true;
      form.querySelector('button').remove();
      roundResults.push({ wordId: word.id, answer, correct });
      document.querySelector('#feedback-slot').innerHTML = `<div class="feedback ${correct ? 'correct' : 'wrong'}" role="status" aria-live="polite">${correct ? '✓ 정답이에요!' : '✕ 다시 만날 단어예요.'}<br>정답: <span lang="ja">${escapeHtml(word.written)} (${escapeHtml(word.reading)})</span></div><div class="actions two"><button class="secondary" id="exit-recall" type="button">나가기</button><button class="primary" id="next-recall" type="button">${index + 1 === queue.length ? '이번 회차 마치기' : '다음'}</button></div>`;
      document.querySelector('#exit-recall').addEventListener('click', renderDashboard);
      const next = document.querySelector('#next-recall');
      next.focus();
      next.addEventListener('click', () => {
        index += 1;
        if (index < queue.length) return render();
        recordRecallAttempt(progress, day.date, roundResults);
        persist();
        const remaining = getRecallQueue(day);
        if (!remaining.length) return renderDailyComplete(day);
        queue = remaining;
        index = 0;
        roundResults = [];
        render();
      });
    });
    document.querySelector('#recall-answer').focus();
  };
  render();
}

function renderDailyComplete(day) {
  setView(`<section class="panel"><p class="eyebrow">오늘의 coverage 완료</p><h1>모든 단어를 한 번씩 맞혔어요! 🌿</h1><p>${day.wordIds.length}개 단어의 뜻을 일본어로 떠올렸습니다. 예정된 날에 다시 만나요.</p><button class="primary" id="complete-home" type="button">홈으로</button></section>`);
  document.querySelector('#complete-home').addEventListener('click', renderDashboard);
}

function startReview(requestedCount) {
  const date = today();
  const byId = wordMap();
  const learnedIds = getLearnedWordIds(progress).filter((id) => byId.has(id));
  const count = Number.isInteger(requestedCount) && requestedCount > 0
    ? Math.min(requestedCount, learnedIds.length)
    : Math.min(10, learnedIds.length);
  const queue = selectCumulativeReviewIds(progress, count, previousReviewWordIds).filter((id) => byId.has(id));
  previousReviewWordIds = [...queue];
  const initialCount = queue.length;
  let index = 0;
  const render = () => {
    if (!queue.length || index >= queue.length) {
      setView(`<section class="panel"><h1>복습 완료! 🍃</h1><p>지금까지 배운 단어 중 ${initialCount}개를 복습했어요.</p><button class="primary" id="review-home">홈으로</button></section>`);
      document.querySelector('#review-home').addEventListener('click', renderDashboard);
      return;
    }
    const word = byId.get(queue[index]);
    setView(`<section class="panel"><p class="eyebrow">누적 복습 · ${index + 1}/${queue.length}</p>${progressBar(index, queue.length)}<p class="muted">뜻을 보고 일본어를 입력하세요. 틀린 단어는 마지막에 다시 나와요.</p><div class="question">${escapeHtml(word.meaningKo)}</div><form class="answer-form"><input id="review-answer" lang="ja" aria-label="일본어 답" autocomplete="off" required><button class="primary">확인</button></form><div id="feedback-slot"></div></section>`);
    const form = document.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (form.dataset.done) return;
      form.dataset.done = 'true';
      const correct = isAcceptedAnswer(word, document.querySelector('#review-answer').value);
      if (correct) completeDueReview(progress, word.id, date);
      else queue.push(word.id);
      persist();
      form.remove();
      document.querySelector('#feedback-slot').innerHTML = `<div class="feedback ${correct ? 'correct' : 'wrong'}" role="status">${correct ? '✓ 기억했어요!' : '✕ 마지막에 다시 풀어요.'}<br>${escapeHtml(word.written)} (${escapeHtml(word.reading)})</div><button class="primary" id="review-next">다음</button>`;
      const next = document.querySelector('#review-next');
      next.focus();
      next.addEventListener('click', () => { index += 1; render(); });
    });
    document.querySelector('#review-answer').focus();
  };
  render();
}

function startExtraPractice() {
  if (!extraPracticeDrills.length) return renderDataError('추가 연습 문항이 아직 없어요.');
  const selected = selectPracticeBatch(extraPracticeDrills, 10, previousExtraQuestionIds);
  previousExtraQuestionIds = selected.map(({ id }) => id);
  runQuestionSession(selected, (responses, questions) => {
    const result = scoreDiagnostic(questions, responses);
    setView(`<section class="panel"><p class="eyebrow">정규 진도에 영향 없는 추가 연습</p><h1>${result.correct}/${result.total}</h1><p>연습 결과는 오늘의 학습·복습·캘린더에 저장하지 않았어요.</p><div class="actions two"><button class="secondary" id="extra-again">다시 연습</button><button class="primary" id="extra-home">홈으로</button></div></section>`);
    document.querySelector('#extra-again').addEventListener('click', startExtraPractice);
    document.querySelector('#extra-home').addEventListener('click', renderDashboard);
  }, { title: '조사·활용 추가 연습' });
}

function startKatakanaPractice() {
  if (!katakanaDrills.length) return renderDataError('가타카나 연습 문항이 아직 없어요.');
  const selected = selectPracticeBatch(katakanaDrills, 10, previousKatakanaQuestionIds);
  previousKatakanaQuestionIds = selected.map(({ id }) => id);
  runQuestionSession(selected, (responses, questions) => {
    const result = scoreDiagnostic(questions, responses);
    setView(`<section class="panel"><p class="eyebrow">가타카나 짧은 연습 완료</p><h1>${result.correct}/${result.total}</h1><p>장음·작은 글자·비슷한 모양을 다시 확인했어요. 이 결과는 정규 진도에 영향을 주지 않아요.</p><div class="actions two"><button class="secondary" id="katakana-again">다시 연습</button><button class="primary" id="katakana-home">홈으로</button></div></section>`);
    document.querySelector('#katakana-again').addEventListener('click', startKatakanaPractice);
    document.querySelector('#katakana-home').addEventListener('click', renderDashboard);
  }, { title: '가타카나 빠르게 읽기' });
}

function renderDataError(message) {
  setView(`<section class="panel"><h1>준비 중 문제가 생겼어요</h1><p>${escapeHtml(message)}</p><button class="primary" id="retry-load">다시 불러오기</button></section>`);
  document.querySelector('#retry-load').addEventListener('click', () => location.reload());
}

async function initialize() {
  try {
    const cloudStart = setupCloudSync();
    const [wordResponse, diagnosticResponse, extraPracticeResponse, katakanaResponse] = await Promise.all([
      fetch('./data/words.json'),
      fetch('./data/diagnostic.json'),
      fetch('./data/extra-practice.json'),
      fetch('./data/katakana.json'),
    ]);
    if (!wordResponse.ok || !diagnosticResponse.ok || !extraPracticeResponse.ok || !katakanaResponse.ok) throw new Error('학습 데이터를 불러올 수 없습니다.');
    [words, diagnostics, extraPracticeDrills, katakanaDrills] = await Promise.all([wordResponse.json(), diagnosticResponse.json(), extraPracticeResponse.json(), katakanaResponse.json()]);
    if (!Array.isArray(words) || !Array.isArray(diagnostics) || diagnostics.length !== 30 || !Array.isArray(extraPracticeDrills) || extraPracticeDrills.length !== 50 || !Array.isArray(katakanaDrills) || katakanaDrills.length !== 50) throw new Error('학습 데이터 형식이 올바르지 않습니다.');
    await Promise.race([cloudStart, new Promise((resolve) => setTimeout(resolve, 4500))]);
    progress = normalizeProgressShape(progress);
    persist();
    initialized = true;
    if (progress.diagnostic?.completed) renderDashboard();
    else renderWelcome();
  } catch (error) {
    renderDataError(error.message);
  }
}

accountButton.addEventListener('click', () => {
  accountMessage.textContent = cloudSync ? '' : '현재는 이 기기에만 저장되고 있어요.';
  settingsMessage.textContent = '';
  accountSettingsChanged = false;
  dailyWordCountInput.value = String(normalizeDailyWordCount(progress.settings?.dailyWordCount));
  updateAccountUi();
  accountDialog.showModal();
});

dailyWordCountForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const requested = Number(dailyWordCountInput.value);
  if (!Number.isInteger(requested) || requested < 1 || requested > 30) {
    settingsMessage.textContent = '1~30 사이의 정수를 입력해 주세요.';
    dailyWordCountInput.focus();
    return;
  }
  progress.settings = {
    dailyWordCount: normalizeDailyWordCount(requested),
    revision: (Number.isInteger(progress.settings?.revision) ? progress.settings.revision : 0) + 1,
  };
  persist();
  accountSettingsChanged = true;
  settingsMessage.textContent = '저장되었습니다. 다음 신규 학습부터 적용됩니다.';
});

accountDialog.addEventListener('close', () => {
  if (accountSettingsChanged && viewMode === 'dashboard') renderDashboard();
  accountSettingsChanged = false;
});

accountForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!cloudSync) return;
  const formData = new FormData(accountForm);
  const accountId = String(formData.get('accountId') ?? '').trim().toLowerCase();
  const pin = String(formData.get('pin') ?? '');
  const action = event.submitter?.value || 'sign-in';
  const claimState = action === 'sign-up' ? structuredClone(progress) : null;
  accountMessage.textContent = action === 'sign-up' ? '새 계정을 만드는 중…' : '로그인하는 중…';
  accountForm.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
  try {
    if (action === 'sign-up') await cloudSync.signUp(accountId, pin);
    else await cloudSync.signIn(accountId, pin);
    localStorage.setItem('kotoba-no-ki:account-id', accountId);
    if (claimState) await cloudSync.save(claimState);
    await cloudSync.whenIdle();
    cloudSync.applyDeferred();
    accountMessage.textContent = '연결되었습니다.';
    accountForm.reset();
    updateAccountUi();
    accountDialog.close();
  } catch {
    accountMessage.textContent = '아이디와 PIN을 확인해 주세요. 새 아이디라면 “새 계정 만들기”를 눌러 주세요.';
  } finally {
    accountForm.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
  }
});

signOutButton.addEventListener('click', async () => {
  if (!cloudSync) return;
  signOutButton.disabled = true;
  try {
    await cloudSync.signOut();
    localStorage.removeItem('kotoba-no-ki:account-id');
    updateAccountUi();
    accountDialog.close();
  } finally {
    signOutButton.disabled = false;
  }
});

homeButton.addEventListener('click', () => {
  cloudSync?.applyDeferred();
  progress.diagnostic?.completed ? renderDashboard() : renderWelcome();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
initialize();
