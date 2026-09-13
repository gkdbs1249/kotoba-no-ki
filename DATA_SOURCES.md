# Kotoba no Ki 데이터 출처와 검수 기록

## 배포 라이선스

`data/words.json`은 OpenJLPT에서 선별·번역·재구성한 파생 데이터이며 **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)** 조건으로 배포한다.

- 라이선스 전문: https://creativecommons.org/licenses/by-sa/4.0/
- 이용 시 이 문서의 저작자 표시를 유지하고, 파생 데이터도 같은 라이선스로 배포해야 한다.
- JLPT는 공식 어휘 목록을 공개하지 않는다. 이 데이터의 N5/N4 표시는 공식 판정이 아니라 아래 커뮤니티 자료에 기반한 학습용 근사 분류다.

## 사용한 원자료

### OpenJLPT

- 저장소: https://github.com/evanclan/OpenJLPT
- 확인한 리비전: `c42fd9fa3777bfc1775446f7c418d549dfd6e4cf`
- 사용 파일: `data/csv/vocab-n5.csv`, `data/csv/vocab-n4.csv`
- 라이선스: CC BY-SA 4.0
- 사용 범위: 표제어 후보, 읽기·뜻 확인, N5/N4 분류

OpenJLPT의 고지에 따라 다음 상위 출처에도 저작자 표시를 한다.

- **JMdict / EDICT, Electronic Dictionary Research and Development Group (EDRDG)** — 어휘 읽기와 영문 뜻. CC BY-SA 4.0. https://www.edrdg.org/
- **Jonathan Waller's JLPT Resources** — 비공식 N5–N1 레벨 분류. CC BY. https://www.tanos.co.uk/jlpt/
- **Tatoeba** — OpenJLPT 원본에 수록된 일·영 예문. CC BY 2.0 FR. https://tatoeba.org/

## Kotoba no Ki에서 한 변경

- 첫 릴리스에 필요한 101개를 선별했다: N5 61개, N4 40개.
- 배열 순서는 원본 CSV의 가나다순을 따르지 않고, 한국인 성인 초급 학습자가 실제로 자주 접하는 흐름으로 수동 재배열했다. 자기소개·지시어·시간 표현·핵심 생활 동사·장소/교통·일정/업무 순으로 우선했다. 이는 말뭉치의 수치 빈도 순위가 아니라 **실생활 활용 빈도에 따른 교육용 순서**다.
- OpenJLPT/JMdict의 영문 뜻을 그대로 번역하지 않고, 문맥에서 바로 쓸 수 있는 자연스러운 한국어 뜻으로 좁히거나 다듬었다.
- 표제어가 한자를 포함하면 표준 가나 읽기를 반드시 넣었다. 가나 전용 표제어는 `reading`을 `written`과 동일하게 기록했다.
- `acceptedAnswers`에는 표제어와 가나 읽기를 넣고 중복을 제거했다. 따라서 학습자가 한자를 직접 입력하지 않아도 가나로 답할 수 있다.
- `example`의 일본어·전체 읽기·한국어 번역은 Kotoba no Ki용으로 새로 작성하고 문장별로 수동 검수했다. 이 예문들은 Tatoeba 문장을 복제하지 않는다.
- 각 레코드의 `source` 객체에 사용한 OpenJLPT 파일, 상위 어휘/레벨 출처, 자체 작성 예문 여부를 기록했다.

## 진단평가 설계와 검수

`data/diagnostic.json`은 30문항이며 다음 비율을 고정했다. `data/katakana.json`은 학습자 맞춤 보충용으로 별도 작성한 16문항이며, 장음 `ー`, 작은 `ッ`, 요음 `ャュョ`, `シ/ツ`·`ソ/ン` 구별을 다룬다. 두 연습 데이터의 문항과 한국어 해설은 Kotoba no Ki용 자체 작성물이다.

| 영역 | 문항 수 | 확인 내용 |
|---|---:|---|
| vocabulary | 8 | 생활 핵심어, N5 기초와 N4 진입 어휘 |
| reading | 5 | 한자 읽기 3문항, 가타카나 2문항 |
| particle | 6 | は, を, に, で, が, と |
| conjugation | 6 | 정중형·과거·부정·て형·い/な형용사 |
| sentence | 5 | 기본 어순, 시간·장소, 이유절, 인용절 |

학습자 특성에 맞춰 히라가나는 빠르게 판별하되 가타카나 능력을 별도로 확인하도록 정확히 2문항을 배치했다. 한자 문항에는 읽기를 함께 보이거나 가나 읽기를 답하게 했으며, 한자를 직접 써야 정답이 되는 문항은 없다. 선택형, 가나 입력형, 어순 배열형을 모두 포함했다. 모든 해설은 정답뿐 아니라 조사·활용·어순의 이유를 한국어로 설명한다.

## 품질 확인

- 모든 표제어가 지정된 OpenJLPT N5/N4 CSV에 실제로 존재하는지 대조했다.
- ID 형식과 중복, 필수 문자열, `acceptedAnswers`, 3개 언어 예문 필드를 검사했다.
- 한자 표제어의 읽기 존재 여부와 가나 전용 표제어의 `written === reading`을 검사했다.
- 선택형 정답이 `choices`에 포함되는지, 배열형 정답이 제시 어절과 일치하는지 검사했다.
- 진단평가의 영역별 문항 수, 응답 방식, `subskill`, 가타카나 문항 수를 검사했다.
- 프로젝트 계약 테스트: `node --test tests/data-contract.test.mjs`
