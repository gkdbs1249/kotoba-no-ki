# ことばの木 / Kotoba no Ki

한국어 사용자를 위한 일본어 N5·N4 학습 PWA입니다. GitHub Pages는 정적 앱만 배포하고, 선택적으로 Firebase Authentication + Cloud Firestore가 계정별 진도를 동기화합니다. Firebase를 설정하지 않아도 기존 `localStorage` 학습은 계속 동작합니다.

첫 공개 버전에는 사람이 검수한 어휘 101개(N5 61개, N4 40개), N5 진단 30문항, 가타카나 보충 16문항이 포함됩니다. 이는 JLPT N5·N4 전체 공식 어휘 목록이 아니라 앱의 첫 학습 묶음이며, 출처와 가공 원칙은 `DATA_SOURCES.md`에 기록합니다.

## 로컬 실행과 검증

```bash
npm test
python3 -m http.server 4173
# http://localhost:4173
```

모듈과 서비스 워커는 `file://`이 아니라 HTTP(S)에서 확인하세요.

## 동기화 설계

`src/cloud-sync.mjs`는 Firebase SDK에 직접 결합되지 않은 동기화 코어입니다.

- 아이디는 소문자 `[a-z0-9_]{4,20}`로 정규화한 뒤 `@accounts.kotoba-no-ki.invalid` 전용 이메일로 변환합니다.
- PIN은 정확히 숫자 6자리이며 Firebase Email/Password의 비밀번호로 전달합니다.
- 로컬 진도는 `kotoba-no-ki:progress:user:<encoded UID>`로 계정마다 분리합니다. 로그아웃 상태는 하나의 `kotoba-no-ki:progress:anonymous` 키만 사용합니다.
- 첫 `onAuthStateChanged` 콜백에서 로컬 프로필을 고른 뒤 시작 장벽을 해제합니다. Firestore 트랜잭션이 느려도 화면 시작을 막지 않습니다.
- 모든 쓰기는 `users/{uid}/progress/current`를 transaction read→merge→write하고, 커밋된 merge 결과를 다시 로컬에 적용합니다.
- `onSnapshot`, `online`, `focus`, visible 전환, BFCache `pageshow`가 원격 변경을 pull합니다.
- 계정이 바뀌면 이전 listener를 해제하고 UID/generation guard로 늦은 콜백을 폐기합니다.
- 쓰기 A 도중 더 최신 상태 B가 생기면 A의 성공/실패가 B를 지우지 않습니다.
- 학습 화면이 객체 참조를 보유하는 동안에는 `shouldDeferRemote` hook이 UI 적용을 보류하고, 안전한 경계에서 `applyDeferred()`를 호출할 수 있습니다. 보류 중에도 병합 상태는 UID 로컬 저장소에 내구적으로 저장됩니다.
- `resetAt`이 더 최신인 세대가 과거 진도를 폐기합니다. 날짜별 cohort/word ID/완료 상태와 review interval은 union·monotonic merge하고, 설정은 `settings.revision`이 높은 쪽을 선택합니다.

앱 연결 시 Firebase modular SDK 인스턴스를 `createFirebaseAdapters({ authSdk, firestoreSdk, authInstance, db })`에 전달한 뒤 반환된 adapter를 `createCloudSync(...)`에 전달합니다. 일반 로컬 저장 직후 `sync.save(progress)`를 호출하고, 앱 초기화는 첫 auth callback 또는 4.5초 안전 제한까지 기다립니다. `applyState`는 진행 중인 학습 화면을 이동시키지 않고 안전한 대시보드 경계에서만 다시 그립니다.

## Firebase 설정

1. 전용 Firebase 프로젝트 `kotoba-no-ki-gkdbs1249`와 Web App을 사용합니다.
2. Authentication에서 **Email/Password** 제공자를 켭니다.
3. Firestore를 만들고 아래 규칙을 배포합니다.
   ```bash
   firebase deploy --only firestore:rules
   ```
4. GitHub Pages 호스트(예: `username.github.io`)를 Authentication의 Authorized domains에 추가합니다.
5. `firebase-config.mjs`에는 브라우저에 공개되는 Firebase Web App 식별 정보만 둡니다. 이 설정은 클라이언트 앱에서 원래 공개되는 값이며 권한은 Authentication과 Firestore rules가 통제합니다. service-account JSON, refresh/access token, 사용자 PIN은 절대 커밋하지 않습니다.
6. 앱은 설정 모듈 import 실패를 잡아 Firebase UI를 비활성화하고 로컬 모드로 계속 시작해야 합니다. 서비스 워커도 선택 설정 파일을 precache하지 않으므로 설정이 없어도 atomic install이 성공합니다.

> **보안 한계:** 6자리 PIN은 낮은 엔트로피이며 이메일 복구 수단도 없습니다. 이 계정은 비민감 학습 진도 전용입니다. 결제·신원·건강정보 등에 사용하지 말고 Firebase의 rate limiting과 모니터링을 유지하세요. 로그인 오류 문구로 계정 존재 여부를 과도하게 노출하지 마세요.

`firestore.rules`는 로그인 UID와 경로 UID가 같을 때만 `current` 진도 문서를 읽고 쓰게 하며, 허용 필드·기본 타입·컬렉션 크기를 제한합니다. 실제 Firebase와 임시 계정을 사용한 Chromium·WebKit 2-context 수렴 및 계정 격리 회귀를 배포 전 실행합니다.

## PWA 캐시

`sw.js`의 cache 이름은 `kotoba-no-ki-v2`입니다. 설치 시 모든 필수 정적 파일을 먼저 fetch/검증하고 나서 cache에 기록하며, 어떤 fetch/put이든 실패하면 후보 cache 전체를 삭제합니다. 활성화 시 이 앱 prefix의 이전 cache만 제거합니다. Firebase/API/CDN 요청과 사용자 데이터는 cache하지 않습니다.

런타임 파일을 변경할 때마다 cache 버전을 올리고, 기존 설치 PWA의 old→new 업그레이드를 확인하세요. `skipWaiting()`/`clients.claim()`은 이미 실행 중인 문서의 JavaScript를 교체하지 않으므로 안전한 시점의 새로고침 또는 앱 재실행이 필요합니다.

`index.html`에는 다음 연결이 필요합니다.

```html
<link rel="manifest" href="./manifest.webmanifest">
```

```js
navigator.serviceWorker?.register('./sw.js').catch(console.error);
```

## GitHub Pages

`.github/workflows/pages.yml`은 `main` push 또는 수동 실행 시 다음을 수행합니다.

1. Node test와 JavaScript syntax check
2. 런타임 파일만 `_site`에 복사
3. Pages artifact 업로드 및 `actions/deploy-pages` 배포

Repository **Settings → Pages → Source**를 **GitHub Actions**로 지정하세요. 배포 후 HTTPS에서 `index.html`, 앱 모듈, manifest, service worker를 직접 확인하고 동일 계정 2개 브라우저 컨텍스트의 실시간 수렴 및 서로 다른 두 계정의 격리를 검증하세요.
